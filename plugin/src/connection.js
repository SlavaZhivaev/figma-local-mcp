/* Browser-only bridge controller. No Figma or DOM dependencies. */
(function (root) {
  'use strict';
  const PORTS = [38471, 38472, 38473, 38474];
  function endpoint(value) {
    let raw = String(value || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(raw)) raw = 'http://' + raw;
    const url = new URL(raw);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
        || !PORTS.includes(Number(url.port)) || url.username || url.password
        || url.search || url.hash || url.pathname !== '/') {
      throw Error('Нужен локальный адрес 127.0.0.1:38471–38474');
    }
    return 'http://localhost:' + url.port;
  }
  class BridgeConnection {
    constructor(options) {
      this.options = options;
      this.fetch = options.fetch || root.fetch.bind(root);
      this.pause = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
      this.session = options.session;
      this.run = null;
      this.pending = null;
      this.finished = Promise.resolve();
      this.counter = 0;
    }
    get running() { return !!this.run; }
    current(run) { return this.run === run && !run.stopped; }
    status(run, text, state) {
      if (this.current(run) && this.options.onStatus) this.options.onStatus(text, state);
    }
    start(url, token) {
      const address = endpoint(url), key = String(token || '').trim();
      if (!key) throw Error('Нужен ключ подключения');
      // A second start invalidates every callback of the earlier loop first.
      this.goodbye();
      this.stop();
      const run = {id: ++this.counter, address, key, stopped: false,
                   controllers: new Set(), saved: false, failures: 0, retry: 700};
      run.completed = new Map();
      this.run = run;
      if (this.options.onRunning) this.options.onRunning(true);
      this.finished = this.loop(run).finally(() => {
        if (this.current(run)) this.stop();
      });
      return this.finished;
    }
    stop() {
      const run = this.run;
      if (!run) return;
      this.run = null;
      run.stopped = true;
      for (const controller of run.controllers) controller.abort();
      run.controllers.clear();
      this.pending = null;
      if (this.options.onRunning) this.options.onRunning(false);
    }
    async request(run, path, data, timeout = 5000, pair) {
      const controller = new AbortController();
      run.controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await this.fetch((pair ? pair.address : run.address) + path, {
          method: 'POST', headers: {Authorization: 'Bearer ' + (pair ? pair.key : run.key),
                                   'Content-Type': 'application/json'},
          body: JSON.stringify(data), signal: controller.signal
        });
        const body = await response.json();
        if (!response.ok) {
          const error = Error(body && body.error || 'HTTP ' + response.status);
          error.status = response.status;
          throw error;
        }
        if (this.current(run) && body && body.update && this.options.onUpdate) this.options.onUpdate(body.update);
        return body;
      } finally {
        clearTimeout(timer);
        run.controllers.delete(controller);
      }
    }
    async ping(visible) {
      const run = this.run;
      if (run) return this.request(run, '/ping', {session: this.session, visible});
    }
    goodbye() {
      const run = this.run;
      if (!run) return;
      // Unload is best-effort; the server also detects stale sessions.
      try { Promise.resolve(this.fetch(run.address + '/bye', {
        method: 'POST', keepalive: true,
        headers: {Authorization: 'Bearer ' + run.key, 'Content-Type': 'application/json'},
        body: JSON.stringify({session: this.session})
      })).catch(() => {}); } catch (_) {}
    }
    acceptResult(message, owner = this.run) {
      const pending = this.pending;
      if (!this.current(owner) || !pending || pending.owner !== owner
          || pending.id !== message.id || pending.result) return false;
      pending.result = Object.assign({}, message, {session: this.session});
      // Finish immediately: hidden Figma windows throttle timers, not network callbacks.
      this.flush(owner).catch(() => {});
      return true;
    }
    flush(run) {
      const pending = this.pending;
      if (!pending || !pending.result || pending.owner !== run) return Promise.resolve();
      // The polling loop and the message callback share exactly one result request.
      if (pending.delivery) return pending.delivery;
      pending.delivery = this.request(run, '/result', pending.result, 20000, pending.origin)
        .then(reply => {
          if (!this.current(run) || this.pending !== pending) return;
          if (reply && reply.accepted === false) {
            const error = Error('Сервер не подтвердил результат. Проверьте изменения в Figma и подключитесь заново.');
            error.fatal = true;
            pending.fatal = error;
            throw error;
          }
          if (!run.completed) run.completed = new Map();
          run.completed.set(pending.id, {result: pending.result, origin: pending.origin});
          while (run.completed.size > 128) run.completed.delete(run.completed.keys().next().value);
          this.pending = null;
          this.status(run, 'Подключено к ИИ', 'on');
        }).finally(() => { pending.delivery = null; });
      return pending.delivery;
    }
    async discover(run) {
      for (const port of PORTS) {
        if (!this.current(run) || this.pending) return null;
        const address = 'http://localhost:' + port;
        if (address === run.address) continue;
        try {
          const reply = await this.request(run, '/ping', {}, 800, {address, key: run.key});
          if (reply && reply.ok && this.current(run) && !this.pending) return address;
        } catch (_) {}
      }
      return null;
    }
    relocate(run, address) {
      if (this.pending) throw Error('Нельзя переключить сервер до подтверждения команды');
      run.address = endpoint(address);
      run.saved = false;
      if (this.options.onAddress) this.options.onAddress(run.address);
    }
    dispatch(run, job) {
      if (!job || typeof job.id !== 'string' || typeof job.action !== 'string'
          || !job.args || typeof job.args !== 'object') {
        const error = Error('Сервер прислал некорректную команду');
        error.fatal = true;
        throw error;
      }
      if (this.pending) {
        if (this.pending.id === job.id) return; // duplicate delivery: never execute twice
        const error = Error('Новая команда пришла до завершения предыдущей');
        error.fatal = true;
        throw error;
      }
      const cached = run.completed && run.completed.get(job.id);
      if (cached) {
        if (cached.origin.address !== run.address) {
          const error = Error('Другой сервер повторно использовал номер завершённой команды');
          error.fatal = true;
          throw error;
        }
        this.pending = {id: job.id, owner: run, result: cached.result,
                        origin: cached.origin, delivery: null};
        this.flush(run).catch(() => {});
        return;
      }
      const pending = {id: job.id, owner: run, result: null, delivery: null,
                       origin: {address: run.address, key: run.key}};
      this.pending = pending;
      const context = {record: pending,
                       isCurrent: () => this.current(run) && this.pending === pending};
      Promise.resolve().then(() => {
        if (context.isCurrent()) return this.options.execute(job, context);
      }).catch(error => {
        if (context.isCurrent()) this.acceptResult({id: job.id, error: String(error.message || error),
          completed: [], failedIndex: 0, partialChangesPossible: false}, run);
      });
    }
    async loop(run) {
      while (this.current(run)) {
        try {
          if (this.pending && this.pending.fatal) throw this.pending.fatal;
          if (this.pending && this.pending.result) await this.flush(run);
          if (!this.current(run)) return;
          if (this.pending) {
            // Heartbeats cannot receive the next job before this result is acknowledged.
            await this.request(run, '/ping', {session: this.session,
              visible: this.options.visible ? this.options.visible() : true});
            if (!this.current(run)) return;
            this.status(run, this.pending ? 'Выполняю команду…' : 'Подключено к ИИ', 'on');
            await this.pause(700);
            continue;
          }
          const idle = true, asked = Date.now();
          const job = await this.request(run, '/poll', Object.assign({}, this.options.info ? this.options.info() : {}, {session: this.session,
            wait: 20, visible: this.options.visible ? this.options.visible() : true}), 30000);
          if (!this.current(run)) return;
          if (job && job.moveTo) {
            this.relocate(run, 'http://localhost:' + job.moveTo);
            this.status(run, 'Переключаюсь на другой сеанс ИИ…');
            continue;
          }
          if (job) this.dispatch(run, job);
          run.failures = 0;
          run.retry = 700;
          this.status(run, this.pending ? 'Выполняю команду…' : 'Подключено к ИИ', 'on');
          if (!run.saved) {
            run.saved = true;
            if (this.options.onSaved) this.options.onSaved({url: run.address, token: run.key});
          }
          if (job || (idle && Date.now() - asked > 1000)) continue;
          await this.pause(this.pending ? 300 : 700);
        } catch (error) {
          if (!this.current(run)) return;
          if (error.fatal || error.status === 401 || error.message === 'Invalid token') {
            this.status(run, error.fatal ? error.message
              : 'Ключ не подходит. Вставьте ключ из статуса подключения.', 'err');
            return;
          }
          run.failures++;
          // Pending results belong to their original server. Never drop them to discover another.
          if (!this.pending && run.failures >= 2) {
            const found = await this.discover(run);
            if (!this.current(run)) return;
            if (found) {
              this.relocate(run, found);
              run.failures = 0;
              this.status(run, 'Переподключаюсь к серверу…');
              continue;
            }
          }
          this.status(run, this.pending
            ? 'Жду связь с сервером и подтверждение команды…'
            : 'Переподключаюсь…', 'err');
          await this.pause(run.retry);
          run.retry = Math.min(run.retry * 2, 3000);
        }
      }
    }
  }
  root.FigmaBridgeVersion = '2.2.0';
  root.FigmaBridgeConnection = BridgeConnection;
  root.FigmaBridgeEndpoint = endpoint;
})(globalThis);

import unittest, subprocess, json, urllib.request, threading, time, os
from server import Bridge

class Tests(unittest.TestCase):
 def test_timeout_before_delivery(self):
  b=Bridge();b.last_seen=time.monotonic()
  with self.assertRaises(ValueError):b.call('x',{},0.01)
  self.assertIsNone(b.job);self.assertFalse(b.blocked)
 def test_timeout_after_delivery(self):
  b=Bridge();b.last_seen=time.monotonic()
  t=threading.Thread(target=lambda:(time.sleep(.01),b.poll('s')));t.start()
  with self.assertRaises(ValueError):b.call('x',{},.05)
  t.join();self.assertTrue(b.blocked);self.assertIsNone(b.poll('s'))
  with self.assertRaises(ValueError):b.call('x',{},.01)
 def test_read_timeout_does_not_block_writes(self):
  b=Bridge();b.last_seen=time.monotonic()
  t=threading.Thread(target=lambda:(time.sleep(.01),b.poll('s')));t.start()
  with self.assertRaises(ValueError):b.call('figma_read',{},.05)
  t.join();self.assertFalse(b.blocked);self.assertIsNone(b.job)
 def test_protocol_and_roundtrip(self):
  p=subprocess.Popen(['/usr/bin/python3','server.py'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env=dict(os.environ,FIGMA_BRIDGE_PORT='0'))
  def send(i,m,params={}):p.stdin.write(json.dumps(dict(jsonrpc='2.0',id=i,method=m,params=params))+'\n');p.stdin.flush()
  def read():return json.loads(p.stdout.readline())
  try:
   send(1,'initialize',{'protocolVersion':'2025-06-18'});self.assertIn('serverInfo',read()['result'])
   p.stdin.write('bad json\n');p.stdin.flush();self.assertEqual(read()['error']['code'],-32700)
   send(2,'tools/list');self.assertEqual(len(read()['result']['tools']),20)
   send(3,'tools/call',{'name':'figma_status'});status=json.loads(read()['result']['content'][0]['text'])
   def post(path,data,token=None):
    req=urllib.request.Request(status['url']+path,data=json.dumps(data).encode(),headers={'Authorization':'Bearer '+(token or status['token']),'Content-Type':'application/json'})
    return json.load(urllib.request.urlopen(req,timeout=3))
   with self.assertRaises(urllib.error.HTTPError):post('/poll',{'session':'test'},'wrong')
   post('/poll',{'session':'test'})
   send(4,'tools/call',{'name':'figma_read'})
   job=None
   for _ in range(20):
    job=post('/poll',{'session':'test'})
    if job:break
    time.sleep(.01)
   self.assertIsNotNone(job);self.assertIsNone(post('/poll',{'session':'test'}))
   send(5,'ping');self.assertEqual(read()['id'],5)
   post('/result',{'id':job['id'],'result':{'nodes':[]}})
   self.assertEqual(read()['id'],4)
   for i in range(100):
    send(100+i,'ping');self.assertEqual(read()['id'],100+i)
  finally:
   p.stdin.close();p.wait(timeout=5);p.stdout.close()
class Screenshot(unittest.TestCase):
 def test_image_comes_back_as_mcp_image(self):
  import base64
  p=spawn(39170)
  try:
   st=status(p,1)
   def post(path,data):
    req=urllib.request.Request(st['url']+path,data=json.dumps(data).encode(),headers={'Authorization':'Bearer '+st['token'],'Content-Type':'application/json'})
    return json.load(urllib.request.urlopen(req,timeout=5))
   post('/poll',{'session':'s'})
   p.rpc(2,'tools/call',{'name':'figma_screenshot','arguments':{'nodeId':'1:2'}})
   job=None
   for _ in range(50):
    job=post('/poll',{'session':'s'})
    if job:break
    time.sleep(.01)
   self.assertEqual(job['action'],'figma_screenshot')
   data=base64.b64encode(os.urandom(2*1024*1024)).decode()  # bigger than the old 512 KB cap
   post('/result',{'id':job['id'],'result':{'nodeId':'1:2','mimeType':'image/png','width':10,'height':10,'data':data}})
   r=p.reply()['result']
   self.assertFalse(r['isError'])
   self.assertEqual(r['content'][0]['type'],'image');self.assertEqual(r['content'][0]['data'],data)
   self.assertNotIn('data',json.loads(r['content'][1]['text']))
  finally:
   p.stdin.close();p.wait(timeout=5);p.stdout.close();p.stderr.close()
 def test_batch_limit_is_500(self):
  p=spawn(39180)
  try:
   p.rpc(1,'tools/call',{'name':'figma_apply','arguments':{'operations':[{'action':'select','id':'1:1'}]*501}})
   r=p.reply()['result'];self.assertTrue(r['isError']);self.assertIn('1–500',r['content'][0]['text'])
   p.rpc(2,'tools/call',{'name':'figma_apply','arguments':{'operations':[{'action':'select','id':'1:1'}]*500}})
   r=p.reply()['result'];self.assertIn('Open Figma Local MCP plugin',r['content'][0]['text'])  # passed validation
  finally:
   p.stdin.close();p.wait(timeout=5);p.stdout.close();p.stderr.close()

class Takeover(unittest.TestCase):
 def call_async(self,b,action):
  out={}
  t=threading.Thread(target=lambda:out.update(r=b.call(action,{},5)));t.start();time.sleep(.05)
  return out,t
 def test_fresh_session_still_wins(self):
  b=Bridge()
  self.assertIsNone(b.poll('a'))
  with self.assertRaises(ValueError):b.poll('b')
 def test_takeover_releases_undelivered_job(self):
  b=Bridge();b.session='old';b.last_seen=time.monotonic()
  out,t=self.call_async(b,'figma_apply')
  b.last_seen=time.monotonic()-11
  self.assertIsNone(b.poll('new'))
  t.join(2)
  self.assertIn('before the command was delivered',out['r']['error'])
  self.assertFalse(b.blocked);self.assertIsNone(b.job);self.assertEqual(b.session,'new')
 def test_takeover_after_delivery_blocks_writes(self):
  b=Bridge();b.last_seen=time.monotonic()
  out,t=self.call_async(b,'figma_apply')
  self.assertIsNotNone(b.poll('old'))
  b.last_seen=time.monotonic()-11
  self.assertIsNone(b.poll('new'))
  t.join(2)
  self.assertIn('outcome is unknown',out['r']['error'])
  self.assertTrue(b.blocked);self.assertIsNone(b.job)
 def test_unblock_restores_writes(self):
  b=Bridge();b.last_seen=time.monotonic()
  out,t=self.call_async(b,'figma_apply')
  self.assertIsNotNone(b.poll('old'))
  b.last_seen=time.monotonic()-11
  self.assertIsNone(b.poll('new'));t.join(2)
  self.assertTrue(b.blocked)
  with self.assertRaises(ValueError) as e:b.call('figma_apply',{},.01)
  self.assertIn('unknown outcome',str(e.exception))
  b.unblock()
  with self.assertRaises(ValueError) as e:b.call('figma_apply',{},.01)
  self.assertIn('timed out',str(e.exception))  # прошло дальше блокировки
 def test_takeover_after_read_does_not_block(self):
  b=Bridge();b.last_seen=time.monotonic()
  out,t=self.call_async(b,'figma_read')
  self.assertIsNotNone(b.poll('old'))
  b.last_seen=time.monotonic()-11
  self.assertIsNone(b.poll('new'))
  t.join(2)
  self.assertFalse(b.blocked)

def spawn(port):
  p=subprocess.Popen(['/usr/bin/python3','-u','server.py'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE,text=True,env=dict(os.environ,FIGMA_BRIDGE_PORT=str(port),FIGMA_AUTO_RAISE='0'))
  p.rpc=lambda i,m,params={}:(p.stdin.write(json.dumps(dict(jsonrpc='2.0',id=i,method=m,params=params))+'\n'),p.stdin.flush())
  p.reply=lambda:json.loads(p.stdout.readline())
  return p
def status(p,i):
  p.rpc(i,'tools/call',{'name':'figma_status'});return json.loads(p.reply()['result']['content'][0]['text'])

class Slots(unittest.TestCase):
 def test_second_client_takes_next_port(self):
  a,b=spawn(39140),spawn(39140)
  try:
   sa,sb=status(a,1),status(b,1)
   slots={'http://127.0.0.1:%d'%(39140+i) for i in range(4)}
   self.assertEqual({sa['url'],sb['url']}-slots,set())
   self.assertNotEqual(sa['url'],sb['url'])  # both bridges listen, order is a race
   self.assertEqual(sa['token'],sb['token'])  # one key per user, shared by every client
  finally:
   for p in (a,b):p.stdin.close();p.wait(timeout=5);p.stdout.close();p.stderr.close()
 def test_all_slots_busy_keeps_mcp_alive(self):
  import socket
  held=[]
  for i in range(4):
   s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',39150+i));s.listen(1);held.append(s)
  p=spawn(39150)
  try:
   p.rpc(1,'tools/list');self.assertEqual(len(p.reply()['result']['tools']),20)
   st=status(p,2)
   self.assertFalse(st['connected']);self.assertIsNone(st['url']);self.assertIn('busy',st['error'])
   p.rpc(3,'tools/call',{'name':'figma_read'});r=p.reply()['result']
   self.assertTrue(r['isError']);self.assertIn('not listening',r['content'][0]['text'])
  finally:
   p.stdin.close();p.wait(timeout=5);p.stdout.close();p.stderr.close()
   for s in held:s.close()
 def test_no_plugin_means_not_connected(self):
  p=spawn(39160)
  try:
   self.assertFalse(status(p,1)['connected'])
   t=time.monotonic()
   p.rpc(2,'tools/call',{'name':'figma_read'});r=p.reply()['result']
   self.assertTrue(r['isError']);self.assertIn('Open Figma Local MCP plugin',r['content'][0]['text'])
   self.assertLess(time.monotonic()-t,5)
  finally:
   p.stdin.close();p.wait(timeout=5);p.stdout.close();p.stderr.close()

if __name__=='__main__':unittest.main()


class Extras(unittest.TestCase):
 def test_export_is_written_to_disk(self):
  import base64, tempfile, server
  d=tempfile.mkdtemp()
  v={'result':{'name':'Экран / 1','format':'SVG','data':base64.b64encode(b'<svg/>').decode()}}
  out=server.save_export(v,{'path':d})['result']
  self.assertTrue(out['path'].endswith('.svg'));self.assertEqual(open(out['path'],'rb').read(),b'<svg/>')
  self.assertEqual(out['svg'],'<svg/>');self.assertNotIn('data',out)
 def test_image_path_becomes_base64(self):
  import tempfile, server, base64
  f=tempfile.NamedTemporaryFile(suffix='.png',delete=False);f.write(b'PNGDATA');f.close()
  a=server.prepare_apply({'operations':[{'action':'update','id':'1:1','props':{'fills':[{'type':'IMAGE','path':f.name,'scaleMode':'FIT'}]}}]})
  p=a['operations'][0]['props']['fills'][0]
  self.assertEqual(base64.b64decode(p['data']),b'PNGDATA');self.assertNotIn('path',p);self.assertEqual(p['scaleMode'],'FIT')
 def test_html_file_inlines_local_assets(self):
  import tempfile, server
  d=tempfile.mkdtemp()
  open(os.path.join(d,'s.css'),'w').write('body{background:url(bg.png)} .a{color:red}')
  open(os.path.join(d,'bg.png'),'wb').write(b'IMG')
  open(os.path.join(d,'app.js'),'w').write('document.title="x"')
  open(os.path.join(d,'i.html'),'w').write('<html><head><link rel="stylesheet" href="s.css"><link rel="stylesheet" href="https://cdn/x.css"></head><body><img src="bg.png"><script src="app.js"></script></body></html>')
  h=server.inline_html_file(os.path.join(d,'i.html'))
  self.assertIn('.a{color:red}',h);self.assertIn('data:image/png;base64,SU1H',h);self.assertIn('https://cdn/x.css',h)
  self.assertIn('document.title="x"',h);self.assertNotIn('src="bg.png"',h)
 def test_import_html_needs_content(self):
  p=spawn(39190)
  try:
   status(p,1)
   p.rpc(2,'tools/call',{'name':'figma_import_html','arguments':{}})
   self.assertTrue(p.reply()['result']['isError'])
  finally: p.kill();p.wait(timeout=5);p.stdin.close();p.stdout.close();p.stderr.close()


class Persistence(unittest.TestCase):
 def test_key_survives_restart_and_ping_takes_no_job(self):
  import tempfile
  tf=os.path.join(tempfile.mkdtemp(),'k','token')
  env=dict(os.environ,FIGMA_BRIDGE_PORT='39210',FIGMA_BRIDGE_TOKEN_FILE=tf)
  keys=[]
  for _ in range(2):
   p=subprocess.Popen(['/usr/bin/python3','-u','server.py'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
   p.rpc=lambda i,m,params={},p=p:(p.stdin.write(json.dumps(dict(jsonrpc='2.0',id=i,method=m,params=params))+'\n'),p.stdin.flush())
   p.reply=lambda p=p:json.loads(p.stdout.readline())
   try:
    st=status(p,1);keys.append(st['token'])
    req=urllib.request.Request(st['url']+'/ping',data=b'{}',headers={'Authorization':'Bearer '+st['token'],'Content-Type':'application/json'})
    self.assertTrue(json.load(urllib.request.urlopen(req,timeout=3))['ok'])
   finally: p.kill();p.wait(timeout=5);p.stdin.close();p.stdout.close();p.stderr.close()
  self.assertEqual(keys[0],keys[1]);self.assertEqual(oct(os.stat(tf).st_mode&0o777),'0o600')
 def test_server_reloads_itself_in_the_same_session(self):
  import tempfile, shutil
  d=tempfile.mkdtemp();shutil.copy('server.py',d);shutil.copy('bridge_queue.py',d)
  env=dict(os.environ,FIGMA_BRIDGE_PORT='39220',FIGMA_BRIDGE_TOKEN_FILE=os.path.join(d,'token'))
  p=subprocess.Popen(['/usr/bin/python3','-u',os.path.join(d,'server.py')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
  p.rpc=lambda i,m,params={}:(p.stdin.write(json.dumps(dict(jsonrpc='2.0',id=i,method=m,params=params))+'\n'),p.stdin.flush())
  p.reply=lambda:json.loads(p.stdout.readline())
  try:
   p.rpc(1,'initialize',{'protocolVersion':'2025-06-18'})
   self.assertTrue(p.reply()['result']['capabilities']['tools']['listChanged'])
   before=status(p,2)
   time.sleep(1.1)
   src=open(os.path.join(d,'server.py')).read().replace("VERSION = '","VERSION = 'reloaded-",1)
   open(os.path.join(d,'server.py'),'w').write(src)
   note=p.reply()   # arrives once the file has been quiet for a second
   self.assertEqual(note['method'],'notifications/tools/list_changed')
   p.rpc(3,'initialize',{'protocolVersion':'2025-06-18'})
   self.assertTrue(p.reply()['result']['serverInfo']['version'].startswith('reloaded-'))
   after=status(p,4)
   self.assertEqual(before['url'],after['url']);self.assertEqual(before['token'],after['token'])
  finally: p.kill();p.wait(timeout=5);p.stdin.close();p.stdout.close();p.stderr.close()


class CodeLayers(unittest.TestCase):
 def test_project_folder_uses_its_build(self):
  import tempfile, server
  d=tempfile.mkdtemp(); os.makedirs(os.path.join(d,'dist'))
  open(os.path.join(d,'index.html'),'w').write('<script type="module" src="/src/main.tsx"></script>')
  open(os.path.join(d,'dist','index.html'),'w').write('<html><body><h1>Built</h1><script src="app.js"></script></body></html>')
  open(os.path.join(d,'dist','app.js'),'w').write('console.log(1)')
  html,src,note,pages=server.html_from_source(d)
  self.assertTrue(src.endswith(os.path.join('dist','index.html')));self.assertIn('Built',html);self.assertIn('console.log(1)',html);self.assertIsNone(note)
 def test_design_context_is_saved_with_assets(self):
  import tempfile, server, base64
  d=tempfile.mkdtemp()
  v={'result':{'name':'Карточка','html':'<html>ok</html>','assets':{'img-1.png':base64.b64encode(b'P').decode()},'screenshot':base64.b64encode(b'S').decode()}}
  out,shot=server.save_design_context(v,{'outDir':d})
  r=out['result'];self.assertEqual(open(r['path']).read(),'<html>ok</html>')
  self.assertEqual(open(os.path.join(d,'assets','img-1.png'),'rb').read(),b'P');self.assertEqual(base64.b64decode(shot),b'S');self.assertNotIn('screenshot',r)
 def test_long_code_goes_to_a_file(self):
  import tempfile, server
  d=tempfile.mkdtemp()
  v={'result':{'meta':{'name':'Лендинг'},'code':'x'*200000}}
  r=server.shrink_code(v,{'path':d})['result']
  self.assertEqual(len(open(r['path']).read()),200000);self.assertLess(len(r['code']),4000);self.assertEqual(r['chars'],200000)

 def test_project_pages_are_packed_with_a_router(self):
  import tempfile, server, json, re
  d=tempfile.mkdtemp(); os.makedirs(os.path.join(d,'sub'))
  open(os.path.join(d,'index.html'),'w').write('<html><body><a href="about.html">О нас</a></body></html>')
  open(os.path.join(d,'about.html'),'w').write('<html><body><h1>О нас</h1><script>var x="</script>";</script></body></html>')
  open(os.path.join(d,'sub','faq.html'),'w').write('<html><body>FAQ</body></html>')
  html,src,note,pages=server.html_from_source(d)
  self.assertEqual(pages,['about.html','index.html','sub/faq.html'])
  m=re.search(r'<script id="__figma_pages" type="application/json" data-entry="([^"]*)">(.*?)</script>',html,re.S)
  self.assertEqual(m.group(1),'index.html');blob=m.group(2)
  self.assertEqual(sorted(json.loads(blob)),pages);self.assertIn('__figma_router',html)
  self.assertEqual(html.count('</body>'),1)

 def test_comments_need_a_token(self):
  import server
  old=os.environ.pop('FIGMA_TOKEN',None); f=server.FIGMA_TOKEN_FILE; server.FIGMA_TOKEN_FILE='/nonexistent/token'
  try:
   with self.assertRaises(ValueError) as e: server.figma_comments({'url':'https://www.figma.com/design/AbCdEfGhIjKlMnOp/x'})
   self.assertIn('personal access token',str(e.exception))
  finally:
   server.FIGMA_TOKEN_FILE=f
   if old: os.environ['FIGMA_TOKEN']=old

 def test_annotations_prompts_and_instructions(self):
  p=spawn(39230)
  try:
   p.rpc(1,'initialize',{'protocolVersion':'2025-06-18'}); r=p.reply()['result']
   self.assertIn('figma_status',r['instructions']);self.assertIn('prompts',r['capabilities'])
   p.rpc(2,'tools/list'); tools={t['name']:t for t in p.reply()['result']['tools']}
   self.assertTrue(tools['figma_read']['annotations']['readOnlyHint']);self.assertFalse(tools['figma_apply']['annotations']['readOnlyHint'])
   p.rpc(3,'prompts/list'); names=[x['name'] for x in p.reply()['result']['prompts']]
   self.assertIn('accessibility_pass',names)
   p.rpc(4,'prompts/get',{'name':'html_prototype','arguments':{'path':'/tmp/x'}})
   self.assertIn('/tmp/x',p.reply()['result']['messages'][0]['content']['text'])
  finally: p.kill();p.wait(timeout=5);p.stdin.close();p.stdout.close();p.stderr.close()

 def test_code_layer_exports_as_website_folder(self):
  import tempfile, server
  d=tempfile.mkdtemp(); os.makedirs(os.path.join(d,'src'))
  open(os.path.join(d,'src','index.html'),'w').write('<html><body><a href="step1.html">Дальше</a></body></html>')
  open(os.path.join(d,'src','step1.html'),'w').write('<html><body>Шаг 1</body></html>')
  html,_,_,_=server.html_from_source(os.path.join(d,'src'))
  entry,written=server.export_pages(html, os.path.join(d,'out'))
  self.assertEqual(written,['index.html','step1.html'])
  self.assertNotIn('__figma_router',open(entry).read());self.assertIn('Шаг 1',open(os.path.join(d,'out','step1.html')).read())

 def test_github_links_and_pack_pages(self):
  import server, tempfile
  m=server.GITHUB.match('https://github.com/acme/site/tree/main/apps/web'); self.assertEqual(m.groups(),('acme','site','main','apps/web'))
  self.assertEqual(server.GITHUB.match('github.com/acme/site.git').groups()[:2],('acme','site'))
  self.assertIsNone(server.GITHUB.match('/Users/me/site'))
  html=server.pack_pages({'index.html':'<html><body>A</body></html>','b.html':'<html><body>B</body></html>'},'index.html')
  self.assertIn('data-entry="index.html"',html);self.assertIn('__figma_router',html);self.assertLess(html.index('A'),html.index('__figma_pages'))
  d=tempfile.mkdtemp(); open(os.path.join(d,'package.json'),'w').write('{}')
  old=server.fetch_repo; server.fetch_repo=lambda url:d
  try:
   with self.assertRaises(ValueError) as e: server.code_from_source('https://github.com/acme/app')
   self.assertIn('npm run build',str(e.exception))
  finally: server.fetch_repo=old

 def test_long_poll_wakes_on_command_and_tracks_visibility(self):
  import server
  b=server.Bridge(); b.last_seen=time.monotonic()
  self.assertIsNone(b.poll('s',0,False)); self.assertIs(b.visible,False)
  got={}
  def waiter(): t=time.monotonic(); got['job']=b.poll('s',5,True); got['t']=time.monotonic()-t
  th=threading.Thread(target=waiter); th.start(); time.sleep(0.3)
  caller=threading.Thread(target=lambda: got.setdefault('err', None) or self._call(b)); caller.start()
  th.join(3); self.assertEqual(got['job']['action'],'figma_read'); self.assertLess(got['t'],2); self.assertIs(b.visible,True)
  b.finish({'id':got['job']['id'],'result':1}); caller.join(3)
 def _call(self,b):
  try: b.call('figma_read',{},3)
  except ValueError: pass
 def test_render_tools_need_the_screen(self):
  import server
  self.assertTrue(server.needs_render('figma_screenshot',{})); self.assertFalse(server.needs_render('figma_read',{}))
  self.assertFalse(server.needs_render('figma_code_layer',{'preview':'none'})); self.assertTrue(server.needs_render('figma_code_layer_run',{'extract':True}))

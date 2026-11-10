import unittest, subprocess, json, urllib.request, urllib.error, threading, time, os, socket, tempfile, base64, stat
import server
from server import Bridge, load_token

PY = '/usr/bin/python3'
TMP = tempfile.mkdtemp(prefix='figma-local-test-')

def live(b, *sessions):
  """Register plugin windows: (session, file) pairs."""
  for sid, f in sessions: b.poll(sid, {'file':f, 'page':'Page 1'})

def call_async(b, action='figma_apply', file=None, **kw):
  out={}
  def run():
    try: out['r']=b.call(action, {}, file, **kw)
    except Exception as e: out['e']=str(e)
  t=threading.Thread(target=run); t.start(); time.sleep(.05)
  return out, t

class Token(unittest.TestCase):
 def test_key_is_created_once_private_and_reused(self):
  path=os.path.join(TMP,'k1','token')
  a=load_token(path); b=load_token(path)
  self.assertEqual(a,b); self.assertGreater(len(a),30)
  self.assertEqual(stat.S_IMODE(os.stat(path).st_mode),0o600)
  self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode)&0o077,0)
 def test_loose_permissions_are_tightened(self):
  path=os.path.join(TMP,'k2','token'); load_token(path); os.chmod(path,0o644)
  load_token(path); self.assertEqual(stat.S_IMODE(os.stat(path).st_mode),0o600)

class Sessions(unittest.TestCase):
 def test_single_file_needs_no_file_argument(self):
  b=Bridge('t'); live(b,('s1','Deck'))
  out,t=call_async(b,'figma_read')
  job=b.poll('s1'); self.assertEqual(job['action'],'figma_read')
  b.finish({'id':job['id'],'result':{'ok':1}}); t.join(2)
  self.assertEqual(out['r']['result'],{'ok':1})
 def test_several_files_route_by_name_and_run_in_parallel(self):
  b=Bridge('t'); live(b,('s1','Vision deck'),('s2','UI kit'))
  with self.assertRaises(ValueError) as e: b.call('figma_read',{},None,wait=0)
  self.assertIn('Several Figma files',str(e.exception))
  o1,t1=call_async(b,'figma_apply','vision')       # part of the name, any case
  o2,t2=call_async(b,'figma_apply','UI kit')       # a second file is not "busy"
  j1,j2=b.poll('s1'),b.poll('s2')
  self.assertIsNotNone(j1);self.assertIsNotNone(j2);self.assertNotEqual(j1['id'],j2['id'])
  b.finish({'id':j2['id'],'result':'two'});b.finish({'id':j1['id'],'result':'one'})
  t1.join(2);t2.join(2)
  self.assertEqual((o1['r']['result'],o2['r']['result']),('one','two'))
 def test_same_file_is_busy_until_done(self):
  b=Bridge('t'); live(b,('s1','Deck'))
  out,t=call_async(b)
  with self.assertRaises(ValueError) as e: b.call('figma_apply',{},'Deck',wait=0)
  self.assertIn('Busy',str(e.exception))
  job=b.poll('s1');b.finish({'id':job['id'],'result':1});t.join(2)
 def test_ambiguous_name_asks_for_session(self):
  b=Bridge('t'); live(b,('s1','Deck'),('s2','Deck'))
  with self.assertRaises(ValueError) as e: b.call('figma_read',{},'Deck',wait=0)
  self.assertIn('session id',str(e.exception))
  out,t=call_async(b,'figma_read','s2')
  self.assertIsNone(b.poll('s1'));self.assertIsNotNone(b.poll('s2'))
  b.sessions['s2']['job']['event'].set();t.join(2)
 def test_unknown_file_lists_connected(self):
  b=Bridge('t'); live(b,('s1','Deck'))
  with self.assertRaises(ValueError) as e: b.call('figma_read',{},'Nope',wait=0)
  self.assertIn('"Deck"',str(e.exception))
 def test_waits_for_a_plugin_to_connect(self):
  b=Bridge('t')
  threading.Timer(.2,lambda:live(b,('s1','Deck'))).start()
  out,t=call_async(b,'figma_read',None,wait=3)
  job=None
  for _ in range(100):
   job=b.poll('s1') if 's1' in b.sessions else None
   if job:break
   time.sleep(.02)
  self.assertIsNotNone(job);b.finish({'id':job['id'],'result':1});t.join(2)
 def test_no_plugin_fails_fast(self):
  b=Bridge('t');t0=time.monotonic()
  with self.assertRaises(ValueError) as e: b.call('figma_read',{},None,wait=.1)
  self.assertIn('No Figma file',str(e.exception));self.assertLess(time.monotonic()-t0,1)

class Outcomes(unittest.TestCase):
 def test_timeout_before_delivery(self):
  b=Bridge('t'); live(b,('s1','Deck'))
  with self.assertRaises(ValueError) as e: b.call('figma_apply',{},timeout=.01)
  self.assertIn('Delivery: False',str(e.exception))
  self.assertIsNone(b.sessions['s1']['job']);self.assertFalse(b.blocked)
 def test_timeout_after_delivery_blocks_writes_to_that_file_only(self):
  b=Bridge('t'); live(b,('s1','Deck'),('s2','Kit'))
  threading.Timer(.01,lambda:b.poll('s1')).start()
  with self.assertRaises(ValueError): b.call('figma_apply',{},'Deck',timeout=.1)
  self.assertEqual(b.blocked,{'Deck'})
  with self.assertRaises(ValueError) as e: b.call('figma_apply',{},'Deck',wait=0)
  self.assertIn('unknown outcome',str(e.exception))
  out,t=call_async(b,'figma_apply','Kit')          # another file still writes
  self.assertIsNotNone(b.poll('s2'))
  b.sessions['s2']['job']['event'].set();t.join(2)
  late=b.sessions['s1']['job']['id'];b.finish({'id':late,'result':1})  # late result unblocks
  self.assertFalse(b.blocked);self.assertIsNone(b.sessions['s1']['job'])
 def test_reads_work_while_blocked(self):
  b=Bridge('t'); live(b,('s1','Deck')); b.blocked.add('Deck')
  out,t=call_async(b,'figma_read')
  self.assertIsNotNone(b.poll('s1'))
  b.sessions['s1']['job']['event'].set();t.join(2)
 def test_unblock_one_file(self):
  b=Bridge('t'); b.blocked={'Deck','Kit'}
  b.unblock('deck');self.assertEqual(b.blocked,{'Kit'})
  b.unblock();self.assertFalse(b.blocked)
 def test_closed_window_before_delivery_frees_the_command(self):
  b=Bridge('t'); live(b,('s1','Deck'))
  out,t=call_async(b)
  b.sessions['s1']['last_seen']-=server.STALE+1
  live(b,('s2','Other'))                           # any poll reaps the dead window
  t.join(2)
  self.assertIn('before the command was delivered',out['r']['error']);self.assertFalse(b.blocked)
  self.assertNotIn('s1',b.sessions)
 def test_closed_window_after_delivery_blocks_that_file(self):
  b=Bridge('t'); live(b,('s1','Deck'))
  out,t=call_async(b)
  self.assertIsNotNone(b.poll('s1'))
  b.sessions['s1']['last_seen']-=server.STALE+1
  live(b,('s2','Deck'))                            # plugin restarted in the same file
  t.join(2)
  self.assertIn('outcome is unknown',out['r']['error']);self.assertEqual(b.blocked,{'Deck'})
 def test_read_lost_after_delivery_does_not_block(self):
  b=Bridge('t'); live(b,('s1','Deck'))
  out,t=call_async(b,'figma_read')
  self.assertIsNotNone(b.poll('s1'))
  b.sessions['s1']['last_seen']-=server.STALE+1
  b.files();t.join(2);self.assertFalse(b.blocked)

def spawn(port, token_file):
  p=subprocess.Popen([PY,'-u','server.py'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,
                     env=dict(os.environ,FIGMA_BRIDGE_PORT=str(port),FIGMA_BRIDGE_TOKEN_FILE=token_file))
  p.rpc=lambda i,m,params={}:(p.stdin.write(json.dumps(dict(jsonrpc='2.0',id=i,method=m,params=params))+'\n'),p.stdin.flush())
  p.reply=lambda:json.loads(p.stdout.readline())
  return p
def stop(*ps):
  for p in ps:
   if p.poll() is None: p.stdin.close(); p.wait(timeout=5)
   p.stdout.close();p.stderr.close()
def tool(p,i,name,args=None):
  p.rpc(i,'tools/call',{'name':name,'arguments':args or {}});return p.reply()['result']
def status(p,i): return json.loads(tool(p,i,'figma_status')['content'][0]['text'])
def post(url,token,path,data,timeout=5):
  req=urllib.request.Request(url+path,data=json.dumps(data).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
  return json.load(urllib.request.urlopen(req,timeout=timeout))
def plugin_answer(url,token,session,file,result,tries=200):
  """Poll like the plugin until a job arrives, then answer it."""
  for _ in range(tries):
   try: job=post(url,token,'/poll',{'session':session,'file':file})
   except (urllib.error.URLError,ConnectionError): job=None
   if job: post(url,token,'/result',{'id':job['id'],'result':result(job)}); return job
   time.sleep(.03)

class Protocol(unittest.TestCase):
 def test_protocol_and_roundtrip(self):
  p=spawn(39101,os.path.join(TMP,'p1'))
  try:
   p.rpc(1,'initialize',{'protocolVersion':'2025-06-18'});self.assertEqual(p.reply()['result']['serverInfo']['version'],server.VERSION)
   p.stdin.write('bad json\n');p.stdin.flush();self.assertEqual(p.reply()['error']['code'],-32700)
   p.rpc(2,'tools/list');self.assertEqual(len(p.reply()['result']['tools']),22)
   st=status(p,3)
   self.assertEqual(st['url'],'http://127.0.0.1:39101');self.assertFalse(st['connected'])
   with self.assertRaises(urllib.error.HTTPError):post(st['url'],'wrong','/poll',{'session':'x'})
   post(st['url'],st['token'],'/poll',{'session':'test','file':'Deck','page':'Slides'})
   st=status(p,4);self.assertEqual([f['file'] for f in st['files']],['Deck']);self.assertEqual(st['files'][0]['page'],'Slides')
   p.rpc(5,'tools/call',{'name':'figma_read','arguments':{'file':'Deck','depth':0}})
   job=plugin_answer(st['url'],st['token'],'test','Deck',lambda j:{'nodes':[]})
   self.assertEqual(job['args'],{'depth':0})              # file is routing, not a plugin argument
   r=p.reply();self.assertEqual(r['id'],5);self.assertFalse(r['result']['isError'])
   for i in range(100): p.rpc(100+i,'ping');self.assertEqual(p.reply()['id'],100+i)
  finally: stop(p)
 def test_key_and_address_survive_restart(self):
  tf=os.path.join(TMP,'p2')
  a=spawn(39102,tf);s1=status(a,1);stop(a)
  b=spawn(39102,tf);s2=status(b,1);stop(b)
  self.assertEqual((s1['url'],s1['token']),(s2['url'],s2['token']))
 def test_screenshot_comes_back_as_image(self):
  p=spawn(39103,os.path.join(TMP,'p3'))
  try:
   st=status(p,1);post(st['url'],st['token'],'/poll',{'session':'s','file':'Deck'})
   data=base64.b64encode(os.urandom(2*1024*1024)).decode()
   p.rpc(2,'tools/call',{'name':'figma_screenshot','arguments':{'nodeId':'1:2'}})
   plugin_answer(st['url'],st['token'],'s','Deck',lambda j:{'nodeId':'1:2','mimeType':'image/png','data':data})
   r=p.reply()['result']
   self.assertEqual(r['content'][0]['type'],'image');self.assertEqual(r['content'][0]['data'],data)
  finally: stop(p)
 def test_batch_limit(self):
  p=spawn(39104,os.path.join(TMP,'p4'))
  try:
   r=tool(p,1,'figma_apply',{'operations':[{'action':'select','id':'1:1'}]*(server.MAX_OPS+1)})
   self.assertTrue(r['isError']);self.assertIn('1–%d'%server.MAX_OPS,r['content'][0]['text'])
  finally: stop(p)

class SharedBridge(unittest.TestCase):
 def test_second_session_forwards_and_takes_over(self):
  tf=os.path.join(TMP,'h1');port=39110
  a=spawn(port,tf);sa=status(a,1)
  b=spawn(port,tf)
  try:
   sb=status(b,1)
   self.assertEqual((sa['url'],sa['token']),(sb['url'],sb['token']))   # one address, one key
   post(sa['url'],sa['token'],'/poll',{'session':'w1','file':'Deck'})
   self.assertEqual([f['file'] for f in status(b,2)['files']],['Deck'])  # b sees a's plugins
   b.rpc(3,'tools/call',{'name':'figma_apply','arguments':{'operations':[{'action':'select','id':'1:1'}]}})
   job=plugin_answer(sa['url'],sa['token'],'w1','Deck',lambda j:[{'id':'1:1','action':'select'}])
   self.assertEqual(job['action'],'figma_apply')
   r=b.reply()['result'];self.assertFalse(r['isError'],r)
   stop(a)                                          # the hub's session closes
   b.rpc(4,'tools/call',{'name':'figma_read','arguments':{}})
   job=plugin_answer(sa['url'],sa['token'],'w1','Deck',lambda j:{'nodes':[]})  # plugin reconnects, same pair
   self.assertIsNotNone(job)
   r=b.reply()['result'];self.assertFalse(r['isError'],r)
  finally: stop(a,b)
 def test_idle_session_takes_over_the_port_by_itself(self):
  tf=os.path.join(TMP,'h2');port=39111
  a=spawn(port,tf);st=status(a,1);b=spawn(port,tf)
  try:
   status(b,1);stop(a)
   for _ in range(60):                              # no tool call on b: the watcher rebinds
    try: post(st['url'],st['token'],'/hello',{});break
    except (urllib.error.URLError,ConnectionError): time.sleep(.1)
   self.assertEqual(post(st['url'],st['token'],'/hello',{})['hub'],'figma-local')
  finally: stop(a,b)
 def test_port_held_by_a_stranger(self):
  s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',39112));s.listen(1)
  p=spawn(39112,os.path.join(TMP,'h3'))
  try:
   t0=time.monotonic();st=status(p,1)
   self.assertFalse(st['connected']);self.assertIn('taken',st['error']);self.assertTrue(st['token'])
   r=tool(p,2,'figma_read');self.assertTrue(r['isError']);self.assertIn('taken',r['content'][0]['text'])
   self.assertLess(time.monotonic()-t0,15)
  finally: stop(p);s.close()

from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
class FakeFigma(BaseHTTPRequestHandler):
  calls=[]
  def log_message(self,*a):pass
  def answer(self,code,data):
   raw=json.dumps(data).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
  def do_GET(self):
   FakeFigma.calls.append(('GET',self.path,self.headers.get('X-Figma-Token'),None))
   if '/files/NOACCESS' in self.path: return self.answer(403,{'status':403,'err':'Invalid token'})
   self.answer(200,{'comments':[
    {'id':'1','message':'Поменять заголовок','user':{'handle':'Женя'},'created_at':'2026-10-18T10:00:00Z','resolved_at':None,'client_meta':{'node_id':'5:6','node_offset':{'x':1,'y':2}},'parent_id':''},
    {'id':'2','message':'Согласен','user':{'handle':'Слава'},'created_at':'2026-10-18T11:00:00Z','resolved_at':None,'client_meta':None,'parent_id':'1','reactions':[{'emoji':':+1:'}]},
    {'id':'3','message':'Старое','user':{'handle':'Женя'},'created_at':'2026-10-01T10:00:00Z','resolved_at':'2026-10-02T10:00:00Z','client_meta':{'x':10,'y':20},'parent_id':''}]})
  def do_POST(self):
   body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
   FakeFigma.calls.append(('POST',self.path,self.headers.get('X-Figma-Token'),body))
   self.answer(200,{'id':'9','message':body['message'],'parent_id':body.get('comment_id',''),'client_meta':body.get('client_meta')})
  def do_DELETE(self):
   FakeFigma.calls.append(('DELETE',self.path,self.headers.get('X-Figma-Token'),None));self.answer(200,{})

class Comments(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.api=ThreadingHTTPServer(('127.0.0.1',0),FakeFigma);threading.Thread(target=cls.api.serve_forever,daemon=True).start()
 @classmethod
 def tearDownClass(cls): cls.api.shutdown()
 def spawn(self,port,token=True):
  d=os.path.join(TMP,'c%d'%port);os.makedirs(d,exist_ok=True)
  if token:
   with open(os.path.join(d,'figma_token'),'w') as f: f.write('figd_test\n')
  env=dict(os.environ,FIGMA_BRIDGE_PORT=str(port),FIGMA_BRIDGE_TOKEN_FILE=os.path.join(d,'token'),FIGMA_API_URL='http://127.0.0.1:%d'%self.api.server_port)
  env.pop('FIGMA_API_TOKEN',None)
  p=subprocess.Popen([PY,'-u','server.py'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
  p.rpc=lambda i,m,params={}:(p.stdin.write(json.dumps(dict(jsonrpc='2.0',id=i,method=m,params=params))+'\n'),p.stdin.flush())
  p.reply=lambda:json.loads(p.stdout.readline())
  return p
 def test_read_write_reply_delete(self):
  p=self.spawn(39120)
  try:
   st=status(p,1);self.assertTrue(st['comments'])
   post(st['url'],st['token'],'/poll',{'session':'w','file':'Deck','fileKey':'KEY123abcDEF'})
   self.assertEqual(status(p,2)['files'][0]['fileKey'],'KEY123abcDEF')
   r=json.loads(tool(p,3,'figma_comments',{'file':'deck'})['content'][0]['text'])
   self.assertEqual(r['total'],1)                                   # resolved thread hidden
   t=r['threads'][0];self.assertEqual((t['id'],t['nodeId'],t['author']),('1','5:6','Женя'))
   self.assertEqual([x['message'] for x in t['replies']],['Согласен']);self.assertEqual(t['replies'][0]['reactions'],[':+1:'])
   self.assertEqual(FakeFigma.calls[-1][1],'/v1/files/KEY123abcDEF/comments?as_md=true');self.assertEqual(FakeFigma.calls[-1][2],'figd_test')
   r=json.loads(tool(p,4,'figma_comments',{'includeResolved':True})['content'][0]['text']);self.assertEqual(r['total'],2)
   self.assertEqual([t['id'] for t in r['threads']],['1','3'])      # newest first
   r=json.loads(tool(p,41,'figma_comments',{'includeResolved':True,'limit':1})['content'][0]['text'])
   self.assertEqual((r['total'],r['shown'],r['truncated']),(2,1,True))
   r=json.loads(tool(p,42,'figma_comments',{'since':'2026-10-18T10:30'})['content'][0]['text']);self.assertEqual(r['total'],1)  # answered since
   r=json.loads(tool(p,43,'figma_comments',{'author':'слав'})['content'][0]['text']);self.assertEqual(r['total'],1)          # reply author
   r=json.loads(tool(p,44,'figma_comments',{'author':'nobody'})['content'][0]['text']);self.assertEqual(r['total'],0)
   r=json.loads(tool(p,5,'figma_comments',{'nodeId':'7:7'})['content'][0]['text']);self.assertEqual(r['total'],0)
   tool(p,6,'figma_comment',{'message':'Готово','nodeId':'5:6','x':4})
   self.assertEqual(FakeFigma.calls[-1][3],{'message':'Готово','client_meta':{'node_id':'5:6','node_offset':{'x':4.0,'y':0.0}}})
   r=json.loads(tool(p,7,'figma_comment',{'message':'Ответ','replyTo':'1','nodeId':'5:6'})['content'][0]['text'])
   self.assertEqual(FakeFigma.calls[-1][3],{'message':'Ответ','comment_id':'1'});self.assertEqual(r['replyTo'],'1')
   tool(p,8,'figma_comment_delete',{'commentId':'9'})
   self.assertEqual(FakeFigma.calls[-1][:2],('DELETE','/v1/files/KEY123abcDEF/comments/9'))
   tool(p,9,'figma_comments',{'url':'https://www.figma.com/design/OTHERkey1234/Name?node-id=1-2'})
   self.assertEqual(FakeFigma.calls[-1][1],'/v1/files/OTHERkey1234/comments?as_md=true')
   r=tool(p,10,'figma_comments',{'url':'https://www.figma.com/design/NOACCESS12/x'})
   self.assertTrue(r['isError']);self.assertIn('403',r['content'][0]['text']);self.assertIn('scopes',r['content'][0]['text'])
  finally: stop(p)
 def test_missing_token_and_missing_key(self):
  p=self.spawn(39121,token=False)
  try:
   self.assertFalse(status(p,1)['comments'])
   r=tool(p,2,'figma_comments',{'url':'https://www.figma.com/file/ABCdef123456/x'})
   self.assertTrue(r['isError']);self.assertIn('personal access token',r['content'][0]['text'])
   st=status(p,3);post(st['url'],st['token'],'/poll',{'session':'w','file':'Draft'})
   r=tool(p,4,'figma_comment',{'message':'x'})
   self.assertTrue(r['isError']);self.assertIn('did not give the plugin the key',r['content'][0]['text'])
  finally: stop(p)

class Updates(unittest.TestCase):
 def test_clone_sees_a_newer_version_upstream(self):
  root=tempfile.mkdtemp(prefix='figma-upd-',dir=TMP)
  def git(cwd,*a): subprocess.run(['git','-C',cwd,'-c','user.name=t','-c','user.email=t@t','-c','init.defaultBranch=main']+list(a),check=True,capture_output=True)
  origin=os.path.join(root,'origin.git');author=os.path.join(root,'author');clone=os.path.join(root,'clone')
  subprocess.run(['git','init','--bare','-b','main',origin],check=True,capture_output=True)
  subprocess.run(['git','clone',origin,author],check=True,capture_output=True)
  with open(os.path.join(author,'server.py'),'w') as f: f.write("VERSION = '1.0.0'\n")
  git(author,'add','.');git(author,'commit','-m','first');git(author,'push','-u','origin','main')
  subprocess.run(['git','clone',origin,clone],check=True,capture_output=True)
  info=server.check_updates(clone)
  self.assertFalse(info['available']);self.assertEqual(info['commitsBehind'],0)
  with open(os.path.join(author,'server.py'),'w') as f: f.write("VERSION = '9.9.9'\n")
  git(author,'commit','-am','Comments filters');git(author,'push')
  info=server.check_updates(clone)
  self.assertTrue(info['available']);self.assertEqual(info['latest'],'9.9.9');self.assertEqual(info['changes'],['Comments filters'])
  self.assertIn('update.sh',info['command'])
  self.assertIn('Not a git checkout',server.check_updates(tempfile.mkdtemp(dir=TMP))['note'])

if __name__=='__main__':unittest.main()

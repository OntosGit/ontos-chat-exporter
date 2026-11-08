import io
import json
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path
from contextlib import redirect_stdout, redirect_stderr
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import ontos_memory as m

CID = '00000000-0000-4000-8000-000000000001'
CID2 = '00000000-0000-4000-8000-000000000002'


def msg(mid, role, text, *, hidden=False):
    result = {'id':mid,'author':{'role':role},'content':{'content_type':'text','parts':[text]},'create_time':1793318400}
    if hidden:result['metadata']={'is_visually_hidden_from_conversation':True}
    return result


def tree(cid=CID):
    messages=[msg('m1','user','Давай построим архитектуру маяков и исследовать новости.'),
              msg('m2','assistant','Я предлагаю создать проект без разрешения.'),
              msg('m3','user','Продолжим проект. Хочу, чтобы он находил архитектуры в наших чатах.'),
              msg('tool','tool','private tool result'),
              msg('hidden','user','секрет, скрыто',hidden=True)]
    nodes={'root': {'id':'root','message':None,'parent':None}}
    parent='root'
    for x in messages:
        nodes[x['id']]={'id':x['id'],'parent':parent,'message':x}
        parent=x['id']
    return {'id':cid,'title':'Архитектура маяков','mapping':nodes,'current_node':parent}


class LocalPilot(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.base=Path(self.tmp.name)
        self.db=self.base/'private'/'ontology.db'
        self.conn=m.connect(self.db)

    def tearDown(self):
        self.conn.close();self.tmp.cleanup()

    def archive(self, body, name='conversations.json'):
        path=self.base/name
        if name.endswith('.zip'):
            with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_DEFLATED) as z:
                z.writestr('conversations.json',json.dumps(body,ensure_ascii=False))
        else:path.write_text(json.dumps(body,ensure_ascii=False),encoding='utf8')
        return path

    def test_01_tree_path_only_visible(self):
        cid,title,messages=m.normalized(tree())
        self.assertEqual(cid,CID)
        self.assertEqual(len(messages),3)
        self.assertNotIn('private tool result',repr(messages))
        self.assertNotIn('секрет',repr(messages))

    def test_02_idempotent_same_file(self):
        p=self.archive([tree()]);r=m.import_file(self.conn,p)
        self.assertEqual(r['messages'],3)
        self.assertEqual(m.import_file(self.conn,p)['status'],'already_imported')
        self.assertEqual(m.summary(self.conn)['revisions'],3)

    def test_03_zip_official(self):
        p=self.archive([tree(),tree(CID2)],'export.zip');r=m.import_file(self.conn,p)
        self.assertEqual(r['conversations'],2)
        self.assertEqual(m.summary(self.conn)['conversations'],2)

    def test_04_direct_messages(self):
        p=self.archive({'conversation_id':CID,'title':'Example','messages':[msg('m1','user','Давай построим проект.')], 'page_info':{'has_previous_page':False,'has_next_page':False}})
        self.assertEqual(m.import_file(self.conn,p)['messages'],1)

    def test_05_reject_partial(self):
        p=self.archive({'conversation_id':CID,'messages':[msg('m1','user','Hello')], 'page_info':{'has_previous_page':True,'has_next_page':False}})
        with self.assertRaises(ValueError):m.import_file(self.conn,p)
        self.assertEqual(m.summary(self.conn)['conversations'],0)

    def test_06_reject_cycle(self):
        obj=tree();obj['mapping']['root']['parent']='m1'
        with self.assertRaises(ValueError):m.normalized(obj)

    def test_07_preserve_revisions_and_latest(self):
        a=tree();m.import_file(self.conn,self.archive(a,'a.json'))
        b=tree();b['mapping']['m1']['message']['content']['parts']=['Давай построим другую архитектуру.']
        m.import_file(self.conn,self.archive(b,'b.json'))
        self.assertEqual(m.summary(self.conn)['revisions'],4)
        self.assertEqual(m.summary(self.conn)['snapshots'],2)
        self.assertEqual(len(m.search(self.conn,'другую',10)),1)
        self.assertEqual(len(m.search(self.conn,'маяков',10)),0)

    def test_08_fulltext_search(self):
        m.import_file(self.conn,self.archive(tree()))
        found=m.search(self.conn,'маяков',20)
        self.assertEqual(len(found),1)
        self.assertEqual(found[0]['message_id'],'m1')
        self.assertTrue(found[0]['link'].endswith(CID))

    def test_09_search_syntax_safe(self):
        m.import_file(self.conn,self.archive(tree()))
        self.assertEqual(m.search(self.conn,'" OR * NEAR --',20),[])

    def test_10_discovery_user_only(self):
        m.import_file(self.conn,self.archive(tree()))
        candidates=m.discover(self.conn,20)
        self.assertEqual(len(candidates),2)
        self.assertTrue(all(x['role']=='user' for x in candidates))
        self.assertEqual(len(m.discover(self.conn,20)),2)
        self.assertEqual(m.summary(self.conn)['candidates'],2)

    def test_11_architecture_record_and_attach(self):
        m.import_file(self.conn,self.archive(tree()))
        rows=m.discover(self.conn,20)
        card=m.record_architecture(self.conn,'ARCH-001','Маяки','researching',rows[0]['candidate_id'],'')
        self.assertEqual(card['id'],'ARCH-001')
        self.assertEqual(len(m.architecture_details(self.conn,'ARCH-001')['evidence']),1)
        with self.assertRaises(ValueError):m.record_architecture(self.conn,'ARCH-001','duplicate','researching',rows[1]['candidate_id'],'')

    def test_12_fts_and_original_survive_reimport(self):
        p=self.archive(tree())
        m.import_file(self.conn,p);m.discover(self.conn,20)
        self.assertEqual(m.import_file(self.conn,p)['status'],'already_imported')
        self.assertEqual(m.summary(self.conn)['candidates'],2)
        self.assertEqual(len(m.search(self.conn,'проект',10)),2)

    def test_13_no_embedded_credentials_in_output(self):
        t=tree();t['mapping']['m1']['message']['content']['parts']=['API_TOKEN_TEST_SECRET plus давай создадим проект']
        m.import_file(self.conn,self.archive(t))
        self.assertNotIn('API_TOKEN_TEST_SECRET',json.dumps(m.summary(self.conn)))

    def test_14_reject_bad_zip(self):
        p=self.base/'bad.zip';p.write_bytes(b'broken')
        with self.assertRaises(zipfile.BadZipFile):m.import_file(self.conn,p)

    def test_15_cli_pilot(self):
        self.archive(tree())
        out=io.StringIO()
        with redirect_stdout(out): code=m.main(['--db',str(self.db),'import',str(self.base/'conversations.json')])
        self.assertEqual(code,0)
        self.assertEqual(json.loads(out.getvalue())['status'],'imported')


    def test_16_genealogy_across_two_conversations(self):
        p=self.archive([tree(),tree(CID2)])
        m.import_file(self.conn,p)
        candidates=m.discover(self.conn,100)
        c1=next(x for x in candidates if x['conversation_id']==CID)
        c2=next(x for x in candidates if x['conversation_id']==CID2)
        m.record_architecture(self.conn,'ARCH-BEACON','Маяки','researching',c1['candidate_id'],'Первичный замысел')
        ref=self.conn.execute('SELECT revision_id FROM candidates WHERE id=?',(c2['candidate_id'],)).fetchone()[0]
        self.conn.execute('INSERT INTO evidence(architecture_id,revision_id,relation) VALUES (?,?,?)',('ARCH-BEACON',ref,'development'))
        self.conn.execute('INSERT INTO external_links(architecture_id,kind,url,observation) VALUES (?,?,?,?)',('ARCH-BEACON','github','https://github.com/OntosGit/ONTOS.NODE/pull/155','requires runtime check'))
        proof=m.architecture_details(self.conn,'ARCH-BEACON')
        self.assertEqual(len(proof['evidence']),2)
        self.assertEqual(len({x['conversation_id'] for x in proof['evidence']}),2)
        self.assertEqual(proof['external_links'][0]['kind'],'github')

    def test_17_main_attach_and_link(self):
        m.import_file(self.conn,self.archive(tree()))
        cs=m.discover(self.conn,20)
        m.record_architecture(self.conn,'ARCH-001','Маяки','researching',cs[0]['candidate_id'],'')
        stdout=io.StringIO()
        with redirect_stdout(stdout):
            self.assertEqual(m.main(['--db',str(self.db),'attach','--id','ARCH-001','--candidate',cs[1]['candidate_id']]),0)
        self.assertEqual(len(json.loads(stdout.getvalue())['evidence']),2)
        stdout=io.StringIO()
        with redirect_stdout(stdout):
            self.assertEqual(m.main(['--db',str(self.db),'link','--id','ARCH-001','--kind','github','--url','https://github.com/OntosGit/ONTOS.NODE']),0)
        self.assertEqual(json.loads(stdout.getvalue())['external_links'][0]['kind'],'github')

    def test_18_older_snapshot_does_not_replace_newer(self):
        newer=tree();newer['update_time']=2000000000
        m.import_file(self.conn,self.archive(newer,'new.json'))
        old=tree();old['update_time']=1790000000
        old['mapping']['m1']['message']['content']['parts']=['Старая версия другого содержания']
        m.import_file(self.conn,self.archive(old,'old.json'))
        self.assertEqual(len(m.search(self.conn,'маяков',20)),1)
        self.assertEqual(len(m.search(self.conn,'Старая',20)),0)
        self.assertEqual(m.summary(self.conn)['snapshots'],2)

if __name__=='__main__':unittest.main()
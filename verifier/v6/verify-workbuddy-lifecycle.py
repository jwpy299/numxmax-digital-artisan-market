#!/usr/bin/env python3
import json,os,sys,datetime,pathlib,hashlib
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=pathlib.Path(os.environ.get('NUMX_OUTPUT_DIR','/mnt/agents/output'))
RUNS=ROOT/'verifier'/'runs'; RUNS.mkdir(parents=True,exist_ok=True)
adapter=json.loads((OUT/'WorkBuddy-ARP适配器验收.json').read_text())
cancel=json.loads((OUT/'WorkBuddy-ARP撤销验收.json').read_text())
r=adapter['result']; c=cancel['runResult']
criteria={'adapter_delivered':r['ok'] is True and r['provider']=='workbuddy-agent' and bool(r['agentSession'].get('ticketId')),'result_hash_matches':r['resultSha256']==hashlib.sha256(r['content'].encode()).hexdigest(),'cancelled':cancel['cancelResponse']['cancelled'] is True and c['status']=='cancelled','no_late_delivery':c['answer'] is None and c['resultSha256'] is None and c['error']=='agent_cancelled','cancel_idempotent':adapter['cancelIdempotent'] is True}
passed=all(criteria.values())
now=datetime.datetime.now(datetime.timezone.utc)
result={'schema':'numx.verifier.run.v1','verifierVersion':'v6','timestamp':now.isoformat(),'command':' '.join(sys.argv),'criteria':{k:{'pass':v} for k,v in criteria.items()},'workbuddyLifecyclePassed':passed,'readyForProduction':False,'note':'验证真实 workbuddy Ticket／事件／交付／撤销，不把 executed/submitted 当 accepted，不替代独立验收和原工资链。','exitCode':0 if passed else 2}
path=RUNS/f"{now.strftime('%Y%m%dT%H%M%S%fZ')}-{os.getpid()}-workbuddy.json"
path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'workbuddyLifecyclePassed':passed,'criteria':criteria,'runRecord':str(path)},ensure_ascii=False,indent=2))
sys.exit(result['exitCode'])

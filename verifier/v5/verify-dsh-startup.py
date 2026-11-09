#!/usr/bin/env python3
import json,os,sys,datetime,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=pathlib.Path(os.environ.get('NUMX_OUTPUT_DIR','/mnt/agents/output'))
RUNS=ROOT/'verifier'/'runs'; RUNS.mkdir(parents=True,exist_ok=True)
evidence=json.loads((OUT/'DSH启动恢复验收.json').read_text())
criteria={'isolated_start_passed':evidence['isolatedStart'] is True,'http_route_verified':evidence['httpStatus']==400 and evidence['probe'].get('error')=='empty_task','production_not_restarted':evidence['productionRestarted'] is False,'canonical_untouched':evidence['productionCanonicalTouched'] is False}
passed=all(criteria.values())
now=datetime.datetime.now(datetime.timezone.utc)
result={'schema':'numx.verifier.run.v1','verifierVersion':'v5','timestamp':now.isoformat(),'command':' '.join(sys.argv),'criteria':{k:{'pass':v} for k,v in criteria.items()},'dshStartupRecovered':passed,'readyForProduction':False,'note':'仅验证 DSH 磁盘启动依赖恢复和隔离 HTTP 路由，未调用模型，不等于生产重启或 Agent 上游验收。','exitCode':0 if passed else 2}
path=RUNS/f"{now.strftime('%Y%m%dT%H%M%S%fZ')}-{os.getpid()}-dsh-startup.json"
path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'dshStartupRecovered':passed,'criteria':criteria,'runRecord':str(path)},ensure_ascii=False,indent=2))
sys.exit(result['exitCode'])

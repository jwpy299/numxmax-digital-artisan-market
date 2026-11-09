#!/usr/bin/env python3
import json,os,sys,datetime,pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=pathlib.Path(os.environ.get('NUMX_OUTPUT_DIR','/mnt/agents/output'))
RUNS=ROOT/'verifier'/'runs'; RUNS.mkdir(parents=True,exist_ok=True)
evidence=json.loads((OUT/'NumXMax-EXE-OSS资格验收.json').read_text())
head=subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True).strip()
tree=subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD^{tree}'],text=True).strip()
criteria={'local_tree_matches_final_build':tree==evidence['buildTree'],'remote_final_sha_recorded':evidence['sourceSha']=='164c20788849995b0ca9aa01b8aa0dedd3171cff','frontend_assets_excluded':evidence['frontendAssetsExcluded'] is True,'gsap_paths_zero':evidence['gsapPathsFound']==0,'org_entries_complete':len(evidence['orgEntries'])>=5}
passed=all(criteria.values())
now=datetime.datetime.now(datetime.timezone.utc)
result={'schema':'numx.verifier.run.v1','verifierVersion':'v4','timestamp':now.isoformat(),'command':' '.join(sys.argv),'criteria':{k:{'pass':v} for k,v in criteria.items()},'localHead':head,'localTree':tree,'remoteFinalSourceSha':evidence['sourceSha'],'ossPackageEligible':passed,'readyForProduction':False,'note':'验证最终公开提交与本地构建 tree 映射及 OSS 资格，不替代 Authenticode、RFC3161 或 Windows VM 证据。','exitCode':0 if passed else 2}
path=RUNS/f"{now.strftime('%Y%m%dT%H%M%S%fZ')}-{os.getpid()}-final-tree.json"
path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'ossPackageEligible':passed,'criteria':criteria,'runRecord':str(path)},ensure_ascii=False,indent=2))
sys.exit(result['exitCode'])

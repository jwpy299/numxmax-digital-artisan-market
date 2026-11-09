#!/usr/bin/env python3
import hashlib,json,os,sys,datetime,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=pathlib.Path(os.environ.get('NUMX_OUTPUT_DIR','/mnt/agents/output'))
RUNS=ROOT/'verifier'/'runs'
RUNS.mkdir(parents=True,exist_ok=True)
accept=json.loads((ROOT/'verifier'/'v1'/'acceptance.json').read_text())
app=json.loads((OUT/'NumXMax_APP_v2.9.66_正式生产签名验收.json').read_text())
relay=json.loads((OUT/'多Agent运行时生产验收接力包.json').read_text())
windows=json.loads((OUT/'NumXMax-EXE签名现状.json').read_text())
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
criteria={}
expected=accept['required']['app']
criteria['app_signed_package']={
 'pass':sha(OUT/'NumXMax_APP_v2.9.66_正式生产签名.apk')==expected['sha256']==app['sha256']
        and app['versionName']==expected['versionName'] and app['versionCode']==expected['versionCode']
        and app['signature']['verified'] and app['signature']['v2'] and app['zipalign'] and not app['debuggable']
        and app['signature']['certificateSha256']==expected['certificateSha256']
        and app['oldUpgradeCompatibility']['certificateChainCompatible'],
 'actual':{'sha256':app['sha256'],'certificateSha256':app['signature']['certificateSha256'],'versionName':app['versionName'],'versionCode':app['versionCode']}}
arp=relay['arp']
registry=(ROOT/'runtime/api/runtimeContainer/registry.ts').read_text()
adapters=(ROOT/'runtime/api/runtimeContainer/adapters.ts').read_text()
criteria['arp_allowlist']={
 'pass':arp['enabled']==accept['required']['arp']['enabled'] and arp['hardClosed']==accept['required']['arp']['hardClosed']
        and "ARP_ENABLED_RUNTIME_IDS = ['dsh', 'kimi', 'workbuddy']" in registry
        and 'if (!agentRuntimeAdapterEnabled(runtime))' in adapters
        and 'AGENT_RUNTIME_${runtime.toUpperCase()}_ENABLED' not in adapters,
 'actual':{'enabled':arp['enabled'],'hardClosed':arp['hardClosed']}}
mysql=arp['realIsolatedMysql']
criteria['canonical_competition_event_review_wage_regression']={
 'pass':mysql['agentEmployment']==14 and mysql['agentRuntimeContainer']==2 and mysql['separateFreshDatabases'] and not mysql['canonicalTouched'],
 'actual':mysql}
for key,field in [('windows_authenticode','authenticodePresent'),('windows_rfc3161','rfc3161TimestampEvidence'),('windows_trusted_publisher','trustedPublisherPresent'),('windows_vm_lifecycle','cleanWindowsVmLifecycleEvidence')]:
 criteria[key]={'pass':windows.get(field) is True,'actual':windows.get(field)}
criteria['public_candidate_pushed']={'pass':relay['github'].get('publicCandidateNotPushed') is False,'actual':relay['github'].get('publicCandidateNotPushed')}
for key,field in [('signpath_submitted','signpathApplicationSubmitted'),('signpath_approved','signpathApproved'),('signpath_token_configured','signpathApiTokenConfigured')]:
 criteria[key]={'pass':windows.get(field) is True,'actual':windows.get(field)}
criteria['kimi_actual_agent']={'pass':arp['kimiActualProbe'].get('ok') is True,'actual':arp['kimiActualProbe']}
criteria['workbuddy_agent_service']={'pass':arp['workbuddy'].get('configured') is True and arp['workbuddy'].get('ready') is True,'actual':arp['workbuddy']}
blocking=[name for name,item in criteria.items() if not item['pass']]
launch_allowed=not blocking
criteria['no_premature_production_launch']={'pass':launch_allowed or relay['production'].get('formalProductionLaunch') is False,'actual':relay['production'].get('formalProductionLaunch')}
if not criteria['no_premature_production_launch']['pass']: blocking.append('no_premature_production_launch')
ready=not blocking
now=datetime.datetime.now(datetime.timezone.utc)
result={'schema':'numx.verifier.run.v1','verifierVersion':'v1','timestamp':now.isoformat(),'command':' '.join(sys.argv),'criteria':criteria,'blocking':blocking,'readyForProduction':ready,'exitCode':0 if ready else 2}
path=RUNS/f"{now.strftime('%Y%m%dT%H%M%S%fZ')}-{os.getpid()}.json"
path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'readyForProduction':ready,'blocking':blocking,'runRecord':str(path)},ensure_ascii=False,indent=2))
sys.exit(result['exitCode'])

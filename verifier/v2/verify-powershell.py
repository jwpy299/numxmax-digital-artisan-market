#!/usr/bin/env python3
import json,os,subprocess,sys,datetime,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[2]
RUNS=ROOT/'verifier'/'runs'; RUNS.mkdir(parents=True,exist_ok=True)
pwsh=os.environ.get('PWSH','/home/kimi/.dotnet/tools/pwsh')
target=ROOT/'desktop/scripts/verify-windows-lifecycle.ps1'
expression="$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('"+str(target).replace("'","''")+"',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count -gt 0){$errors|ForEach-Object{$_.Message};exit 1};Write-Output 'POWERSHELL_PARSE_OK'"
command=[pwsh,'-NoLogo','-NoProfile','-Command',expression]
p=subprocess.run(command,capture_output=True,text=True,timeout=60)
now=datetime.datetime.now(datetime.timezone.utc)
result={'schema':'numx.verifier.run.v1','verifierVersion':'v2','timestamp':now.isoformat(),'command':command,'criteria':{'powershell_lifecycle_script_parse':{'pass':p.returncode==0,'actual':(p.stdout+p.stderr).strip()[-2000:]}},'readyForProduction':False,'note':'仅证明 PowerShell 语法可解析，不是 Windows VM 生命周期实测。','exitCode':p.returncode}
path=RUNS/f"{now.strftime('%Y%m%dT%H%M%S%fZ')}-{os.getpid()}-powershell.json"
path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'parseOk':p.returncode==0,'runRecord':str(path),'actual':result['criteria']['powershell_lifecycle_script_parse']['actual']},ensure_ascii=False,indent=2))
sys.exit(p.returncode)

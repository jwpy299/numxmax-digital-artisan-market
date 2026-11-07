import base64, io, json, sys, zipfile

payload = json.loads(sys.stdin.read())
entries = payload['entries']
if len(entries) < 1 or len(entries) > 64:
    raise ValueError('agent_plugin_zip_entries_invalid')
out = io.BytesIO()
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for entry in entries:
        name = entry['name']
        data = base64.b64decode(entry['data'])
        if not name or len(name) > 128 or name.startswith('/') or '..' in name or chr(92) in name or chr(0) in name:
            raise ValueError('agent_plugin_zip_name_invalid')
        if len(data) > 1024 * 1024:
            raise ValueError('agent_plugin_zip_entry_unsupported')
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100600 << 16
        archive.writestr(info, data)
print(base64.b64encode(out.getvalue()).decode('ascii'))

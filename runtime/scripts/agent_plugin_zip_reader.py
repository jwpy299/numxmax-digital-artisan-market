import base64, io, json, sys, zipfile

MAX_FILE_SIZE = 1024 * 1024

def safe_name(name):
    return bool(name) and len(name) <= 128 and not name.startswith('/') and '..' not in name and chr(92) not in name and chr(0) not in name

def main():
    raw = base64.b64decode(sys.stdin.read())
    if len(raw) < 22 or len(raw) > 5 * 1024 * 1024:
        raise ValueError('agent_plugin_artifact_invalid')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        if len(infos) < 1 or len(infos) > 64:
            raise ValueError('agent_plugin_zip_entries_invalid')
        entries = []
        names = set()
        for info in infos:
            if info.is_dir():
                raise ValueError('agent_plugin_zip_name_invalid')
            name = info.filename
            if not safe_name(name) or name in names:
                raise ValueError('agent_plugin_zip_name_invalid')
            names.add(name)
            if info.flag_bits & 0x1:
                raise ValueError('agent_plugin_zip_entry_unsupported')
            if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError('agent_plugin_zip_entry_unsupported')
            if info.file_size > MAX_FILE_SIZE or info.compress_size > MAX_FILE_SIZE:
                raise ValueError('agent_plugin_zip_entry_unsupported')
            data = archive.read(info)
            if len(data) != info.file_size:
                raise ValueError('agent_plugin_zip_size_mismatch')
            entries.append({'name': name, 'data': base64.b64encode(data).decode('ascii')})
        print(json.dumps({'entries': entries}, ensure_ascii=False))

if __name__ == '__main__':
    main()

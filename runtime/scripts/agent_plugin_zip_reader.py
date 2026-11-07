import base64, io, json, re, sys, zipfile

MAX_FILE_SIZE = 1024 * 1024
MAX_TOTAL_SIZE = 8 * 1024 * 1024


def safe_name(name):
    return bool(name) and len(name) <= 128 and not name.startswith('/') and '..' not in name and chr(92) not in name and chr(0) not in name


def run():
    raw = base64.b64decode(sys.stdin.read())
    if len(raw) < 22 or len(raw) > 5 * 1024 * 1024:
        raise ValueError('agent_plugin_artifact_invalid')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        if len(infos) < 1 or len(infos) > 64:
            raise ValueError('agent_plugin_zip_entries_invalid')
        entries = []
        names = set()
        total_size = 0
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
            if info.file_size > MAX_FILE_SIZE:
                raise ValueError('agent_plugin_zip_entry_unsupported')
            total_size += info.file_size
            if total_size > MAX_TOTAL_SIZE:
                raise ValueError('agent_plugin_zip_total_size_invalid')
            with archive.open(info) as handle:
                data = handle.read(info.file_size + 1)
            if len(data) != info.file_size:
                raise ValueError('agent_plugin_zip_size_mismatch')
            entries.append({'name': name, 'data': base64.b64encode(data).decode('ascii')})
        print(json.dumps({'entries': entries}, ensure_ascii=False))


def main():
    try:
        run()
    except Exception as exc:
        code = str(exc) if re.fullmatch(r'agent_plugin_[a-z0-9_]+', str(exc)) else 'agent_plugin_zip_invalid'
        sys.stderr.write(json.dumps({'error': code}) + '\n')
        raise SystemExit(2)


if __name__ == '__main__':
    main()

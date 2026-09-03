#!/usr/bin/env python3
"""Builds bot/yandex-deploy.zip for upload to Yandex Cloud Functions via
"Source code -> ZIP archive". Contains index.js, src/*.js, the Russian
Trusted Root CA bundle and a minimal package.json - no node_modules needed,
everything uses only Node built-ins.

Uses Python's zipfile with explicit Unix-style directory entries instead of
PowerShell's Compress-Archive: that produced a zip Yandex's own extractor
failed on ("Cannot find module './src/config'") even though the archive was
valid and extracted fine locally with standard tools (Info-ZIP, Python) -
the PowerShell/.NET zip lacked explicit directory entries. This script is
the canonical way to rebuild the archive; do not switch back to
Compress-Archive.

Run from the bot/ folder after any change to index.js or src/*.js:
    python scripts/build-yandex-zip.py
"""

import os
import zipfile

BOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(BOT_DIR, 'yandex-deploy.zip')

FILES = [
    'index.js',
    'src/bot.js',
    'src/catalog.js',
    'src/config.js',
    'src/maxApi.js',
    'src/notify.js',
    'src/objectStorage.js',
    'src/store.js',
    'src/photoTokens.json',
    'certs/russian-trusted-ca-bundle.pem',
]

PACKAGE_JSON = (
    '{\n'
    '  "name": "aura-max-bot",\n'
    '  "version": "1.0.0",\n'
    '  "private": true,\n'
    '  "main": "index.js"\n'
    '}\n'
)


def main():
    if os.path.exists(OUT_PATH):
        os.remove(OUT_PATH)

    with zipfile.ZipFile(OUT_PATH, 'w', zipfile.ZIP_DEFLATED) as z:
        for d in ('src/', 'certs/'):
            info = zipfile.ZipInfo(d)
            info.external_attr = (0o40755 << 16) | 0x10
            info.create_system = 3  # unix
            z.writestr(info, '')

        for rel in FILES:
            src_path = os.path.join(BOT_DIR, rel.replace('/', os.sep))
            if not os.path.exists(src_path):
                if rel == 'src/photoTokens.json':
                    # Ещё не запускали scripts/sync-photos.js - карточки
                    # товаров просто уйдут без фото, ничего не падает.
                    continue
                raise FileNotFoundError(src_path)
            info = zipfile.ZipInfo(rel)
            info.external_attr = 0o644 << 16
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(src_path, 'rb') as f:
                z.writestr(info, f.read())

        info = zipfile.ZipInfo('package.json')
        info.external_attr = 0o644 << 16
        info.create_system = 3
        z.writestr(info, PACKAGE_JSON)

    print('Done:', OUT_PATH)


if __name__ == '__main__':
    main()

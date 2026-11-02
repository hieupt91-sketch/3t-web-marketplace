#!/usr/bin/env python3
"""Offline checks for this specification pack, not a production importer.

Implements only the JSON Schema keywords used by the bundled contract.
Production must use a maintained Draft 2020-12 validator and security policy.
"""
from pathlib import Path
import copy
import json
import re

ROOT = Path(__file__).resolve().parents[1]


def require(ok, message):
    if not ok:
        raise ValueError(message)


def matches(value, schema, at):
    try:
        validate(value, schema, at)
        return True
    except ValueError:
        return False


def validate(value, schema, at='$'):
    supported = {'$schema', 'title', 'type', 'properties', 'required',
                 'additionalProperties', 'minProperties', 'enum', 'const',
                 'pattern', 'minLength', 'minimum', 'maximum', 'items',
                 'minItems', 'maxItems', 'uniqueItems', 'allOf', 'if', 'then', 'not'}
    require(set(schema) <= supported, f'{at}: unsupported schema keyword')
    types = {'object': dict, 'array': list, 'string': str,
             'integer': int, 'boolean': bool}
    if 'type' in schema:
        require(type(value) is types[schema['type']], f'{at}: invalid type')
    if 'const' in schema:
        require(value == schema['const'], f'{at}: invalid constant')
    if 'enum' in schema:
        require(value in schema['enum'], f'{at}: outside enum')
    if isinstance(value, dict):
        for key in schema.get('required', []):
            require(key in value, f'{at}.{key}: required')
        require(len(value) >= schema.get('minProperties', 0), f'{at}: too few properties')
        props = schema.get('properties', {})
        extra = schema.get('additionalProperties', True)
        for key, val in value.items():
            if key in props:
                validate(val, props[key], at + '.' + key)
            elif extra is False:
                raise ValueError(f'{at}.{key}: unknown property')
            elif isinstance(extra, dict):
                validate(val, extra, at + '.' + key)
    if isinstance(value, list):
        require(len(value) >= schema.get('minItems', 0), f'{at}: too few items')
        require(len(value) <= schema.get('maxItems', 10**9), f'{at}: too many items')
        if schema.get('uniqueItems'):
            require(len({json.dumps(x, sort_keys=True) for x in value}) == len(value), f'{at}: duplicates')
        if 'items' in schema:
            for i, item in enumerate(value):
                validate(item, schema['items'], f'{at}[{i}]')
    if isinstance(value, str):
        require(len(value) >= schema.get('minLength', 0), f'{at}: too short')
        if 'pattern' in schema:
            require(re.search(schema['pattern'], value) is not None, f'{at}: pattern mismatch')
    if type(value) in (int, float):
        require(value >= schema.get('minimum', float('-inf')), f'{at}: below minimum')
        require(value <= schema.get('maximum', float('inf')), f'{at}: above maximum')
    for part in schema.get('allOf', []):
        validate(value, part, at)
    if 'if' in schema and matches(value, schema['if'], at):
        validate(value, schema.get('then', {}), at)
    if 'not' in schema:
        require(not matches(value, schema['not'], at), f'{at}: forbidden combination')


def semantic(manifest):
    locales = manifest['locales']
    require(locales['default'] in locales['supported'], 'default locale must be supported')
    for key in ('name', 'summary'):
        require(locales['default'] in manifest[key], f'{key}: default locale missing')
    names = [item['name'] for item in manifest['env']]
    require(len(names) == len(set(names)), 'duplicate env names')
    if manifest['demo']['mode'] == 'isolatedAdmin':
        require('admin' in manifest['capabilities'], 'admin demo needs admin capability')
        require(manifest['adapter'] in ('node-http', 'next-standalone'), 'admin demo needs runtime adapter')


def main():
    schema = json.loads((ROOT / 'contracts/template-manifest.schema.json').read_text())
    manifests = list((ROOT / 'contracts/examples').glob('*.manifest.json'))
    manifests.append(ROOT / 'examples/static-landing/template.manifest.json')
    loaded = []
    for path in manifests:
        data = json.loads(path.read_text())
        validate(data, schema)
        semantic(data)
        loaded.append(data)
    fixture = loaded[-1]
    site = ROOT / 'examples/static-landing' / fixture['projectRoot']
    require((site / fixture['runtime']['entry']).is_file(), 'static entry missing')
    for path in site.glob('*.html'):
        for target in re.findall(r'(?:href|src)="([^"]+)"', path.read_text()):
            if not target.startswith(('https:', 'http:', '#', 'data:')):
                require((path.parent / target).is_file(), f'{path}: broken asset/link {target}')
    negatives = []
    bad = copy.deepcopy(fixture); bad.pop('version'); negatives.append(bad)
    bad = copy.deepcopy(fixture); bad['projectRoot'] = '../escape'; negatives.append(bad)
    bad = copy.deepcopy(fixture); bad['schemaVersion'] = 2; negatives.append(bad)
    bad = copy.deepcopy(fixture); bad['database'] = {'engine':'sqlite'}; negatives.append(bad)
    bad = copy.deepcopy(fixture); bad['adapter'] = 'php'; negatives.append(bad)
    bad = copy.deepcopy(fixture); bad['env'] = [{'name':'KEY','scope':'public','secret':True,'required':True,'description':'bad'}]; negatives.append(bad)
    bad = copy.deepcopy(fixture); bad['env'] = [{'name':'KEY','scope':'server','secret':True,'required':True,'description':'bad','defaultValue':'not-allowed'}]; negatives.append(bad)
    for i, bad in enumerate(negatives):
        require(not matches(bad, schema, '$'), f'negative fixture {i} unexpectedly accepted')
    skip = {'node_modules', '.next', '.git', 'runtime-data', 'dist', 'coverage'}
    markdown = [p for p in ROOT.rglob('*.md') if not skip.intersection(p.relative_to(ROOT).parts)]
    for path in markdown:
        text = path.read_text()
        require(len(re.findall(r'^```', text, re.M)) % 2 == 0, f'{path}: unclosed code fence')
        for link in re.findall(r'\[[^\]]+\]\(([^)]+)\)', text):
            if link.startswith(('http:', 'https:', '#', 'mailto:')):
                continue
            target = link.split('#')[0]
            require((path.parent / target).exists(), f'{path}: broken link {target}')
    ui = re.findall(r'^\| ([PUDBC ARW]\d{2}) \|', (ROOT/'docs/05-ui-ux.md').read_text(), re.M)
    req = re.findall(r'^\| (REQ-\d{2}) \|', (ROOT/'docs/01-san-pham-va-nghiep-vu.md').read_text(), re.M)
    at = re.findall(r'^\| (AT-\d{2}) \|', (ROOT/'docs/10-backlog-va-nghiem-thu.md').read_text(), re.M)
    require(len(ui) == len(set(ui)) == 95, 'UI count/uniqueness')
    require(len(req) == len(set(req)) == 30, 'REQ count/uniqueness')
    require(len(at) == len(set(at)) == 60, 'acceptance count/uniqueness')
    print(json.dumps({'status':'PASS', 'markdown_files':len(markdown), 'manifest_examples':len(manifests),
                      'negative_contract_checks':len(negatives), 'ui_screens':len(ui),
                      'requirements':len(req), 'acceptance_scenarios':len(at)}, ensure_ascii=False))


if __name__ == '__main__':
    main()

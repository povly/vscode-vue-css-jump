'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const registrations = [];

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
}
class Range {
    constructor(a, b) {
        this.a = a;
        this.b = b;
    }
}
class Location {
    constructor(uri, position) {
        this.uri = uri;
        this.position = position;
    }
}
const uriCache = new Map();
function makeUri(p) {
    if (!uriCache.has(p)) {
        uriCache.set(p, { fsPath: p, toString: () => `file://${p}` });
    }
    return uriCache.get(p);
}

const vscodeStub = {
    Uri: { file: makeUri, parse: (s) => makeUri(s.replace('file://', '')) },
    Position,
    Range,
    Location,
    workspace: {
        workspaceFolders: [{ uri: makeUri('/var/www/jpbest'), name: 'jpbest' }],
        getWorkspaceFolder: (uri) => ({ uri: makeUri('/var/www/jpbest') }),
    },
    languages: {
        registerDefinitionProvider: (sel, provider) => {
            registrations.push({ kind: 'definition', provider });
            return { dispose() {} };
        },
    },
    commands: { registerCommand: () => ({ dispose() {} }) },
    ExtensionContext: class {},
};

const origLoad = Module._load;
Module._load = function patched(request, ...rest) {
    if (request === 'vscode') return vscodeStub;
    return origLoad.call(this, request, ...rest);
};

const ext = require('../dist/extension.js');
if (typeof ext.activate !== 'function') {
    throw new Error('activate export missing');
}

const fakeContext = { subscriptions: [], extensionPath: '/tmp' };
ext.activate(fakeContext);

if (!registrations.some((r) => r.kind === 'definition')) {
    throw new Error('definition provider not registered');
}
const provider = registrations.find((r) => r.kind === 'definition').provider;

function makeDoc(abs) {
    const text = fs.readFileSync(abs, 'utf8');
    return {
        uri: makeUri(abs),
        getText: () => text,
        offsetAt: (p) => p.character,
        positionAt: (o) => new Position(0, o),
    };
}

let failures = 0;
function expect(label, cond, extra) {
    if (cond) {
        console.log('ok  ', label);
    } else {
        failures++;
        console.log('FAIL', label, extra ?? '');
    }
}

// 1) $style usage -> class definition in external css
{
    const abs = '/var/www/jpbest/resources/js/components/write-offs/WriteOffCreate.vue';
    const doc = makeDoc(abs);
    const text = doc.getText();
    const i = text.indexOf('$style.field');
    const res = provider.provideDefinition(doc, new Position(0, i + 10));
    expect('$style.field resolves', Array.isArray(res) && res.length > 0 && String(res[0].uri.fsPath).endsWith('write-off-create.css'));
}

// 2) style src path -> css file
{
    const abs = '/var/www/jpbest/resources/js/components/write-offs/document.vue';
    const doc = makeDoc(abs);
    const text = doc.getText();
    const i = text.indexOf('./document.css');
    const res = provider.provideDefinition(doc, new Position(0, i + 3));
    expect('style src resolves', Array.isArray(res) && res.length > 0 && String(res[0].uri.fsPath).endsWith('document.css'));
}

// 3) inline style block
{
    const abs = '/tmp/opencode/mini-vue/src/App.vue';
    const doc = makeDoc(abs);
    const text = doc.getText();
    const i = text.indexOf('$style.');
    const res = provider.provideDefinition(doc, new Position(0, i + 10));
    expect('inline $style resolves or returns null w/o crash', res === null || Array.isArray(res));
}

console.log(failures === 0 ? '\nSMOKE PASSED' : `\nSMOKE FAILED (${failures})`);
process.exit(failures ? 1 : 0);

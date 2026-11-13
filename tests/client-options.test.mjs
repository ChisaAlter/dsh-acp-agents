import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

test('ACP model menu declares and renders native session options with host callbacks', () => {
  const registration = source.slice(source.indexOf("name: 'conversation.input.model',"));
  assert.match(registration, /children:\s*\{\s*'conversation.input.model.options': \{ kind: 'list', scope: 'session' \}/);
  const start = source.indexOf("h('div', { className: 'dsh-acp-ms-session-options' }");
  const end = source.indexOf("\n                h(\n                  'div',\n                  { className: 'dsh-acp-ms-aside-foot' }", start);
  assert.ok(start >= 0 && end > start);
  const render = vm.compileFunction(`return ${source.slice(start, end).trim().replace(/,$/, '')};`,
    ['h', 'renderSlot', 'locked', 'busy', 'close', 'triggerRef', 'setFailedAction', 'toastSeq', 'setToast']);
  for (const [locked, busy] of [[false, false], [true, false], [false, true]]) {
    let slot, options, closed = false, focused = false, failedAction = 'old', toast;
    const toastSeq = { current: 2 };
    const tree = render((type, props, ...children) => ({ type, props, children }), (name, owner) => {
      slot = name; options = owner; return 'native-team-toggle';
    }, locked, busy, () => { closed = true; }, { current: { focus: () => { focused = true; } } },
    value => { failedAction = value; }, toastSeq, value => { toast = value; });
    assert.equal(slot, 'conversation.input.model.options');
    assert.equal(tree.children[0], 'native-team-toggle');
    assert.equal(options.locked, locked || busy);
    options.dismiss();
    assert.equal(closed && focused, true, 'disable confirmation closes menu and restores focus');
    options.reportFailure('Team save rejected');
    assert.equal(failedAction, null, 'native errors must not offer an unrelated model retry');
    assert.equal(toast.text, 'Team save rejected');
    assert.equal(toast.seq, 3);
  }
});

test('session-option keyboard events do not select a model; Escape still dismisses', () => {
  const start = source.indexOf('const onRootKeyDown = (event) => {', source.indexOf('function AgentModelSelect'));
  const end = source.indexOf('\n      const onRootBlur', start);
  assert.ok(start > 0 && end > start);
  class Element {
    closest(selector) { return selector.includes('.dsh-acp-ms-session-options') ? this : null; }
  }
  const makeHandler = vm.compileFunction(`${source.slice(start, end)}\nreturn onRootKeyDown;`,
    ['Element', 'open', 'searchRef', 'close']);
  let closed = false;
  const handler = makeHandler(Element, true, { current: {} }, () => { closed = true; });
  for (const key of ['Enter', ' ', 'ArrowDown', 'Home']) {
    handler({ key, target: new Element(), preventDefault() { assert.fail('Native option owns its key'); } });
    assert.equal(closed, false);
  }
  let prevented = false;
  handler({ key: 'Escape', target: new Element(), preventDefault() { prevented = true; } });
  assert.equal(closed && prevented, true);
});

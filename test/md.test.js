import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMarkdown, toHTML, sanitize } from '../src/md.js';

const ctx = { accentOf: (id) => (id === 'lq3k9abc' ? 'sky' : null) };
const roundTrip = (h) => assert.equal(toHTML(toMarkdown(h), ctx), sanitize(h), toMarkdown(h));

test('round trips the editor vocabulary', () => {
  for (const h of [
    '<p>Hello <b>bold</b> and <i>it</i> and <u>under</u> <strike>gone</strike> <code>a`b</code> <mark>hi</mark></p><p><br></p><p>snake_case and _lead *star* 2 * 3 [x] a==b ~~</p>',
    '<h1>Title</h1><h2 data-fold="">Folded</h2><p>under</p><h3>Small</h3>',
    '<ul><li>one</li><li>two</li><ul><li>nested</li><ul><li>deeper</li></ul></ul><li>three</li></ul><ol><li>a</li><li>b</li><ol><li>c</li></ol></ol>',
    '<ul class="todo"><li data-checked="true">done</li><li>open</li><li><br></li></ul>',
    '<blockquote>quote line<br>second</blockquote><hr><pre>code\n```inner\nx &lt; y</pre>',
    '<table><tbody><tr><th>A</th><th>B|x</th></tr><tr><td>1</td><td><br></td></tr></tbody></table>',
    '<details open=""><summary>Toggle <b>me</b></summary><div class="dt"><p>inside</p><ul><li>x</li></ul><details><summary>inner</summary><div class="dt"><p>deep</p></div></details></div></details><p>after</p>',
    '<p>See <a data-note="lq3k9abc" data-accent="sky">Other pad</a> and <a href="https://example.com/a_(b)">link</a> and <a href="https://x.com">https://x.com</a> and plain https://y.com text</p>',
    '<p>Remind <time data-at="1767225600000">Thu, Jan 1, 9:00 AM</time>&nbsp;with <span data-m="person">Ana</span>&nbsp;at <span data-m="place">Home</span></p>',
    '<p># not a heading</p><p>- not a list</p><p>1. not ordered</p><p>&gt; not quote</p><p>---</p><p>&lt;b&gt;literal&lt;/b&gt; &amp;amp; AT&amp;T</p>',
    '<p><b><i>both</i></b> <i><b>both2</b></i> x<i>intra</i>word</p>',
  ]) roundTrip(h);
});

test('reads ordinary Markdown the way people write it', () => {
  assert.equal(toHTML('Para one\n\nPara two\nline three'), '<p>Para one</p><p>Para two</p><p>line three</p>');
  assert.equal(toHTML('1. a\n\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(toHTML('* a\n    * b\n* c'), '<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul>');
  assert.equal(toHTML('***x*** and __y__'), '<p><b><i>x</i></b> and <b>y</b></p>');
  assert.equal(toHTML('#### deep'), '<h3>deep</h3>');
  assert.equal(toHTML('<script>alert(1)</script> <img src=x onerror=1> [a](javascript:alert(1))'), '<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=1&gt; a</p>');
  assert.equal(toHTML('<b>open'), '<p><b>open</b></p>');
});

test('cleans HTML it is given', () => {
  assert.equal(sanitize('<div onclick="x"><p style="color:red">a<script>b</script></p></div><a href="javascript:x">c</a>'), '<p>a</p>c');
});

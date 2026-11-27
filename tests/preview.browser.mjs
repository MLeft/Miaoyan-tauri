// Synthetic documents only. Browser fixture uses the real Preview and stores;
// only native IO is replaced. runPreviewBrowser is a Node-side CDP runner export.
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function openPreviewFixture() {
  const [{ default: React, act }, { createRoot }, { Preview }, { useNotesStore }, { useSettingsStore }] = await Promise.all([
    import('react'), import('react-dom/client'), import('../src/components/preview/Preview'),
    import('../src/stores/notes-store'), import('../src/stores/settings-store'),
  ]);
  const oldNative = window.__TAURI_INTERNALS__;
  const oldAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const config = useSettingsStore.getState().config;
  const disk = new Map();
  const annotationDisk = new Map();
  const writes = [];
  const messages = [];
  const gates = new Map();
  const parsedHtml = new Map();
  let failWrite = false;
  const note = path => ({ id: path, path, title: path, folder: 'C:/preview-fixture',
    created_at: '', modified_at: '', pinned: false, size: 0, is_encrypted: false });
  window.__TAURI_INTERNALS__ = { ...oldNative,
    convertFileSrc: path => `http://asset.localhost/${path}`,
    async invoke(command, args) {
      if (command === 'read_note') return { id: args.path, content: disk.get(args.path) ?? '', disk_version: disk.get(args.path) ?? '' };
      if (command === 'parse_markdown') {
        if (gates.has(args.content)) return new Promise(resolve => gates.set(args.content, resolve));
        return parsedHtml.get(args.content) ?? args.content;
      }
      if (command === 'read_annotations') {
        const json = gates.has(args.notePath) ? await new Promise(resolve => gates.set(args.notePath, resolve)) : annotationDisk.get(args.notePath) ?? '[]';
        return { document_id: `fixture-${args.notePath}`, json };
      }
      if (command === 'write_annotations' || command === 'delete_annotations') {
        if (args.documentId !== `fixture-${args.notePath}`) throw new Error('Wrong persistent annotation identity');
        if (gates.has(command)) await new Promise(resolve => gates.set(command, resolve));
        if (failWrite) throw new Error('synthetic disk failure');
        annotationDisk.set(args.notePath, args.json ?? '[]');
        writes.push(args); return;
      }
      if (command === 'write_log') return;
      if (command === 'write_note') {
        if (args.expectedVersion !== (disk.get(args.path) ?? '')) throw new Error('DiskConflict');
        disk.set(args.path, args.content); return args.content;
      }
      throw new Error(`Unexpected preview native command: ${command}`);
    },
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  useSettingsStore.setState({ config: { ...config, auto_save_interval: 0 } });
  const mount = document.createElement('div'); mount.style.height = '600px'; document.body.append(mount);
  const root = createRoot(mount);
  const listener = e => messages.push(e.data);
  window.addEventListener('message', listener);
  const store = () => useNotesStore.getState();
  window.__previewFixture = {
    mount, messages, writes, gates, parsedHtml, store,
    async select(path, content) {
      disk.set(path, content);
      await act(async () => { await store().selectNote(note(path)); root.render(React.createElement(Preview)); });
    },
    async edit(content) { await act(async () => store().updateDocumentContent(store().activeNote.path, content, store().getDocumentRevision(store().activeNote.path))); },
    async release(key, value) { await act(async () => { gates.get(key)(value); gates.delete(key); }); },
    failWrite(value) { failWrite = value; },
    async cleanup() {
      await act(async () => root.unmount()); await store().closeAllTabs(); mount.remove();
      window.removeEventListener('message', listener);
      useSettingsStore.setState({ config }); window.__TAURI_INTERNALS__ = oldNative;
      globalThis.IS_REACT_ACT_ENVIRONMENT = oldAct; delete window.__previewFixture;
    },
  };
  await window.__previewFixture.select('C:/preview-fixture/a.md', '<p>first</p>');
}

// Compatible with scripts/test-browser.mjs's send(method, params, sessionId).
// No changes to that shared runner are needed: results.push(await runPreviewBrowser(send, sessionId)).
export async function runPreviewBrowser(send, sessionId, only) {
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const frameSessions = new Map();
  const frame = async expression => {
    const tree = await send('Page.getFrameTree', {}, sessionId);
    let id = tree.frameTree.childFrames?.find(f => f.frame.url.includes('/preview.html'))?.frame.id;
    let frameSession = sessionId;
    if (!id) {
      const { targetInfos } = await send('Target.getTargets');
      const target = targetInfos.find(t => t.type === 'iframe' && t.url.includes('/preview.html'));
      assert(target, 'Real preview iframe missing');
      if (!frameSessions.has(target.targetId)) frameSessions.set(target.targetId, (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId);
      frameSession = frameSessions.get(target.targetId);
      id = (await send('Page.getFrameTree', {}, frameSession)).frameTree.frame.id;
    }
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: id, worldName: 'preview-test' }, frameSession);
    // Execute in the real renderer world via a CDP-inserted trusted test script.
    const code = `delete document.body.dataset.testResult; delete document.body.dataset.testError;
      Promise.resolve().then(async () => { ${expression} }).then(value => document.body.dataset.testResult = JSON.stringify(value ?? null), error => document.body.dataset.testError = String(error.stack || error));`;
    await send('Runtime.evaluate', { contextId: executionContextId, expression: `(()=>{const s=document.createElement('script');s.textContent=${JSON.stringify(code)};document.head.append(s);s.remove()})()` }, frameSession);
    for (let i = 0; i < 150; i++) {
      const result = await send('Runtime.evaluate', { contextId: executionContextId, returnByValue: true,
        expression: '({result:document.body.dataset.testResult,error:document.body.dataset.testError})' }, frameSession);
      if (result.result?.value?.error) throw new Error(result.result.value.error);
      if (result.result?.value?.result) return JSON.parse(result.result.value.result);
      await pause(20);
    }
    throw new Error('Renderer assertion timed out');
  };
  const cases = [];
  const run = async (name, body) => {
    if (only && only !== name) return;
    await evaluate("import('/tests/preview.browser.mjs').then(m => m.openPreviewFixture())");
    try { await pause(750); await body(); cases.push(name); }
    catch (error) {
      const diagnostics = await frame("return {html:document.getElementById('write').innerHTML.slice(0,500),scope:window._scope,purify:typeof window.DOMPurify,needed:window._neededLibs}").catch(() => null);
      const alerts = await evaluate("Array.from(document.querySelectorAll('[role=alert]')).map(el=>el.textContent)");
      throw new Error(`${error.message}; ${JSON.stringify({ diagnostics, alerts })}`);
    }
    finally { await evaluate('window.__previewFixture.cleanup()'); }
  };
  await run('empty-and-path-snapshot', async () => {
    await evaluate("window.__previewFixture.edit('')"); await pause(500);
    assert(await frame("return document.getElementById('write').textContent") === '', 'Empty document retained old HTML');
    const html = '<img src="images/test.png">';
    await evaluate(`window.__previewFixture.select('C:/preview-fixture/one/a.md', ${JSON.stringify(html)})`); await pause(500);
    const a = await frame("return document.querySelector('#write img').getAttribute('src')");
    await evaluate(`window.__previewFixture.select('C:/preview-fixture/two/a.md', ${JSON.stringify(html)})`); await pause(500);
    const b = await frame("return document.querySelector('#write img').getAttribute('src')");
    assert(a !== b && b.includes('/two/'), 'Same HTML reused previous document resource path');
    await evaluate("window.__previewFixture.gates.set('slow', true); window.__previewFixture.edit('slow')"); await pause(350);
    await evaluate("window.__previewFixture.edit('new')"); await pause(500);
    await evaluate("window.__previewFixture.release('slow', '<p>stale</p>')"); await pause(100);
    assert(await frame("return document.getElementById('write').textContent") === 'new', 'Late parse replaced latest revision');
  });
  await run('sandbox-sanitizer-and-messages', async () => {
    assert(await evaluate("document.querySelector('iframe[title=preview]').getAttribute('sandbox')") === 'allow-scripts', 'Preview has no opaque-origin minimal sandbox');
    await evaluate(`window.__previewFixture.select('C:/preview-fixture/x.html', ${JSON.stringify('<h1>safe</h1><table><tr><td>cell</td></tr></table><input type="checkbox"><img src="bad" onerror="parent.__xss=1"><iframe srcdoc="evil"></iframe><script>parent.__xss=1</script><a href="javascript:parent.__xss=1">bad</a><a href="https://example.com">good</a>')})`); await pause(500);
    const safe = await frame("return {bad:!!document.querySelector('#write script,#write iframe,#write [onerror],#write a[href^=javascript]'),good:!!document.querySelector('#write table'),bridge:typeof window.__TAURI_INTERNALS__}");
    assert(!safe.bad && safe.good && safe.bridge === 'undefined', 'Untrusted HTML or native bridge crossed safe reader boundary');
    await evaluate("window.postMessage({type:'checkbox-toggle',index:0}, '*')");
    await frame("window.dispatchEvent(new MessageEvent('message',{data:{type:'setContent',html:'forged',raw:true}})); return null");
    assert(await frame("return document.querySelector('#write h1')?.textContent") === 'safe', 'Forged renderer message accepted');
    await frame("document.querySelector('#write a[href^=https]').click(); return null"); await pause(100);
    assert(await frame("return location.pathname") === '/preview.html', 'Link navigated the renderer');
    await frame("window.DOMPurify=undefined; return null");
    await evaluate("window.__previewFixture.edit('<img onerror=alert(1)>unsafe')"); await pause(500);
    assert(!await frame("return !!document.querySelector('#write img')"), 'Sanitizer failure fell back to raw HTML');
  });
  await run('annotations-races-and-failure', async () => {
    await evaluate("window.__previewFixture.gates.set('C:/preview-fixture/slow.md', true); window.__previewFixture.select('C:/preview-fixture/slow.md','slow')");
    await evaluate("window.__previewFixture.select('C:/preview-fixture/b.md','new quote')"); await pause(500);
    const ann = [{id:'old',quote:'old',comment:'stale comment',heading:'',paragraphIndex:0,status:'open',createdAt:''}];
    await evaluate(`window.__previewFixture.release('C:/preview-fixture/slow.md', ${JSON.stringify(JSON.stringify(ann))})`);
    await evaluate("document.querySelector('button[title=开启批注模式]').click()");
    assert(!await evaluate("window.__previewFixture.mount.textContent.includes('stale comment')"), 'Late annotation load polluted another document');
    await frame("window.PreviewBridge.send({type:'annotation-selection',quote:'new quote',heading:'',paragraphIndex:0}); return null"); await pause(50);
    await evaluate("window.__previewFixture.failWrite(true); const t=document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'retry draft'); t.dispatchEvent(new Event('input',{bubbles:true}));");
    await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='添加').click()"); await pause(100);
    assert(await evaluate("document.querySelector('textarea')?.value") === 'retry draft', 'Failed annotation save lost retry draft');
    assert(await evaluate("!!window.__previewFixture.mount.querySelector('[role=alert]')"), 'Failed annotation save was silent');
    await evaluate("window.__previewFixture.failWrite(false); Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='重试批注保存').click()"); await pause(250);
    assert(await evaluate('window.__previewFixture.writes.length') === 1, 'Annotation draft could not retry');
    await evaluate("window.__previewFixture.select('C:/preview-fixture/c.md','other')"); await pause(500);
    assert(!await evaluate("window.__previewFixture.mount.textContent.includes('retry draft')"), 'Document switch retained old annotations/draft');
  });
  for (const operation of ['close', 'move']) {
    await run(`annotation-write-drains-before-${operation}`, async () => {
      await frame("PreviewBridge.send({type:'annotation-selection',quote:'first',heading:'',paragraphIndex:0}); return null"); await pause(50);
      await evaluate("{ window.__previewFixture.gates.set('write_annotations', true); const t=document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'accepted annotation'); t.dispatchEvent(new Event('input',{bubbles:true})); }");
      await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='添加').click()"); await pause(50);
      await evaluate(`(() => {
        const f=window.__previewFixture, path=f.store().activeNote.path;
        f.finished=false;
        f.operation=${operation === 'close' ? "f.store().closeTab(path)" : "f.store().withDocumentPathChange(path, false, async () => { f.nativeSawAnnotation = f.writes.length === 1; })"}.then(() => { f.finished=true; });
      })()`);
      await pause(50);
      assert(!await evaluate('window.__previewFixture.finished'), `${operation} completed before accepted annotation`);
      assert(await evaluate('window.__previewFixture.store().openTabs.length > 0'), 'Pending annotation lost its session');
      await evaluate("window.__previewFixture.release('write_annotations')");
      await evaluate('window.__previewFixture.operation');
      assert(await evaluate('window.__previewFixture.writes.length') === 1, 'Annotation write was not persisted exactly once');
      if (operation === 'close') {
        await evaluate("window.__previewFixture.select('C:/preview-fixture/a.md','<p>first</p>')"); await pause(500);
        await evaluate("document.querySelector('button[title=开启批注模式]').click()");
        assert(await evaluate("window.__previewFixture.mount.textContent.includes('accepted annotation')"), 'Reopened document lost persisted annotation');
      } else assert(await evaluate('window.__previewFixture.nativeSawAnnotation'), 'Native mutation ran before annotation persistence');
    });
  }
  await run('failed-annotation-survives-switch-and-retry', async () => {
    await frame("PreviewBridge.send({type:'annotation-selection',quote:'first',heading:'',paragraphIndex:0}); return null"); await pause(50);
    await evaluate("{ window.__previewFixture.failWrite(true); const t=document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'retained across switch'); t.dispatchEvent(new Event('input',{bubbles:true})); }");
    await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='添加').click()"); await pause(50);
    await evaluate("window.__previewFixture.select('C:/preview-fixture/b.md','other')");
    await evaluate("window.__previewFixture.select('C:/preview-fixture/a.md','<p>first</p>')"); await pause(500);
    assert(await evaluate("window.__previewFixture.store().getDocumentWork('C:/preview-fixture/a.md','annotation:').draft.includes('retained across switch')"), 'Switch lost the accepted annotation draft');
    await evaluate("window.__previewFixture.failWrite(false); Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='重试批注保存').click()"); await pause(250);
    assert(await evaluate('window.__previewFixture.writes.length') === 1, 'Returned document could not retry');
    assert(await evaluate("window.__previewFixture.mount.textContent.includes('retained across switch')"), 'Retried annotation was not displayed');
  });
  await run('plantuml-denied-by-default', async () => {
    await frame("window.__plantRequests=0; const set=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src').set; Object.defineProperty(HTMLImageElement.prototype,'src',{set(value){if(value.includes('plantuml.com')){window.__plantRequests++;return;}set.call(this,value)}}); return null");
    await evaluate(`window.__previewFixture.edit(${JSON.stringify('<pre><code class="language-plantuml">@startuml\nAlice -&gt; Bob\n@enduml</code></pre>')})`); await pause(700);
    assert(await frame('return window.__plantRequests') === 0, 'PlantUML leaked source without trusted parent consent');
    assert(await frame("return !!document.querySelector('.plantuml-request')"), 'No explicit PlantUML request action');
    await frame("document.querySelector('.plantuml-request').click(); return null"); await pause(50);
    assert(await evaluate("!!document.querySelector('[data-preview-consent]')"), 'PlantUML consent is not in trusted parent UI');
    await evaluate("document.querySelector('[data-preview-consent] button[data-approve]').click()"); await pause(500);
    assert(await frame('return window.__plantRequests') === 1, 'Explicit current-code consent did not render exactly one diagram');
    await evaluate("window.__previewFixture.edit('<p>next</p>')"); await pause(500);
    assert(await frame('return window.__plantRequests') === 1, 'Consent expanded to another render');
  });
  await run('renderer-lifecycle-and-cache', async () => {
    await frame("window.__timers=[]; const old=setTimeout; window.setTimeout=(fn,ms,...args)=>{window.__timers.push(ms);return old(fn,ms,...args)}; DiagramHandler.initializeAll(); return null"); await pause(50);
    assert(!await frame('return window.__timers.includes(500)'), 'No-diagram render starts encoder retry');
    await frame("window.mermaid={initialize(){},render:async()=>({svg:'<svg><text>safe</text><script>window.__xss=1</script></svg>'})}; return null");
    await evaluate(`window.__previewFixture.edit(${JSON.stringify('<pre><code class="language-mermaid">graph TD; A--&gt;B</code></pre>')})`); await pause(500);
    assert(!await frame("return !!document.querySelector('#write svg script')"), 'Diagram SVG bypasses sanitizer');
    const cache = await frame("const d=DiagramHandler; d._svgCache.clear(); d._cacheChars=0; for(let i=0;i<300;i++)d.cacheSvg('source'+i,'<svg>'+('x'.repeat(10000))+'</svg>'); return {size:d._svgCache.size,chars:d._cacheChars};");
    assert(cache.size <= 128 && cache.chars <= 2000000, 'Mermaid cache exceeds LRU/character budget');
    await frame("window.mermaid.render=()=>new Promise(resolve=>window.__finishMermaid=resolve); return null");
    await evaluate("window.__previewFixture.edit('<pre><code class=language-mermaid>pending graph</code></pre>')"); await pause(400);
    await evaluate("window.__previewFixture.edit('<p>latest</p>')"); await pause(400);
    await frame("window.__finishMermaid({svg:'<svg><text>stale</text></svg>'}); return null"); await pause(100);
    assert(await frame("return document.getElementById('write').textContent") === 'latest', 'Late diagram touched latest content');
  });
  await run('toc-first-empty-and-library-failure', async () => {
    await evaluate("window.__previewFixture.edit('<h1>One</h1><h2>Two</h2>')"); await pause(750);
    assert(await frame("document.querySelector('.toc-hover-trigger').dispatchEvent(new MouseEvent('mouseenter')); return document.querySelector('.toc-nav').classList.contains('active')"), 'TOC listeners missing after first headingless document');
    await evaluate("window.__previewFixture.edit('none')"); await pause(750);
    assert(!await frame("return document.querySelector('.toc-nav').classList.contains('active')"), 'TOC stays open without headings');
    await frame("window.__loads=0; const append=document.head.appendChild.bind(document.head); document.head.appendChild=function(el){if(el.src?.includes('mermaid.min.js')){window.__loads++;queueMicrotask(()=>el.onerror());return el}return append(el)}; window.mermaid=undefined; return null");
    await evaluate("window.__previewFixture.edit('<pre><code class=language-mermaid>graph</code></pre>')"); await pause(700);
    assert(await frame('return window.__loads') === 1, 'Failed library did not settle after one attempt');
    assert(await evaluate("!!window.__previewFixture.mount.querySelector('[role=alert]')"), 'Library failure not visibly retryable');
    await frame("window.mermaid={initialize(){},render:async()=>({svg:'<svg><text>retried</text></svg>'})}; return null");
    await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='重试预览').click()"); await pause(500);
    assert(await frame("return !!document.querySelector('#write svg')"), 'Explicit retry did not recover failed library rendering');
    await evaluate("window.__previewFixture.edit('recovered')"); await pause(500);
    assert(await frame("return document.getElementById('write').textContent") === 'recovered', 'Old neededLibs blocks new plain content');
  });
  await run('checkbox-cas-and-unready-annotations', async () => {
    await evaluate(`window.__previewFixture.parsedHtml.set('- [ ] task', '<ul><li><input type="checkbox" disabled> task</li></ul>'); window.__previewFixture.edit('- [ ] task')`); await pause(500);
    await frame("window.__oldScope={..._scope}; window.__oldMessage=()=>_port.postMessage({version:1,channel:_channel,scope:window.__oldScope,type:'checkbox-toggle',index:0}); return null");
    await evaluate("window.__previewFixture.select('C:/preview-fixture/b.md','- [ ] task')"); await pause(500);
    await frame('window.__oldMessage(); return null'); await pause(50);
    assert(await evaluate('window.__previewFixture.store().activeContent') === '- [ ] task', 'Old document checkbox changed new document');
    await frame("document.querySelector('#write input').click(); return null"); await pause(50);
    assert(await evaluate('window.__previewFixture.store().activeContent') === '- [x] task', 'Current task did not commit through CAS');
    await evaluate("window.__previewFixture.gates.set('C:/preview-fixture/unready.md',true); window.__previewFixture.select('C:/preview-fixture/unready.md','unready')"); await pause(500);
    await frame("PreviewBridge.send({type:'annotation-selection',quote:'unready',heading:'',paragraphIndex:0}); return null"); await pause(50);
    assert(!await evaluate("!!document.querySelector('textarea')"), 'Selection allowed CRUD before annotations were loaded');
    const list = [{id:'existing',quote:'unready',comment:'existing on disk',heading:'',paragraphIndex:0,status:'open',createdAt:''}];
    await evaluate(`window.__previewFixture.release('C:/preview-fixture/unready.md',${JSON.stringify(JSON.stringify(list))})`);
    await evaluate("document.querySelector('button[title=开启批注模式]').click()");
    assert(await evaluate("window.__previewFixture.mount.textContent.includes('existing on disk')"), 'Unready annotations overwrote disk list');
    await frame("PreviewBridge.send({type:'annotation-selection',quote:'unready',heading:'',paragraphIndex:0}); return null"); await pause(50);
    await evaluate("window.__previewFixture.select('C:/preview-fixture/other.md','other')"); await pause(500);
    assert(!await evaluate("!!document.querySelector('textarea')"), 'Selection draft crossed document boundary');
  });
  await run('real-libraries-and-safe-labels', async () => {
    await frame("window.__scriptOrder=[]; const append=document.head.appendChild.bind(document.head); document.head.appendChild=function(s){if(s.src)window.__scriptOrder.push({src:s.src.split('/').pop(),d3:!!window.d3,katex:!!window.katex});return append(s)}; return null");
    const html = '<pre><code class="language-mermaid">graph TD; A[Safe]--&gt;B[Label]</code></pre><pre><code class="language-markmap"># Root\n- Child\n- &lt;img src=x onerror="window.__labelXss=1"&gt;</code></pre><p>$x^2$ :smile: &lt;img src=x onerror="window.__emojiXss=1"&gt;</p>';
    await evaluate(`window.__previewFixture.edit(${JSON.stringify(html)})`); await pause(2200);
    const result = await frame("return {mermaid:!!document.querySelector('#write .language-mermaid svg'),markmap:!!document.querySelector('#write .language-markmap svg'),math:!!document.querySelector('#write .katex'),bad:!!document.querySelector('#write [onerror]'),xss:!!(window.__labelXss||window.__emojiXss)}");
    assert(result.mermaid && result.markmap && result.math && !result.bad && !result.xss, `Real local libraries failed safe rendering: ${JSON.stringify(result)}`);
    const order = await frame('return window.__scriptOrder');
    assert(order.find(item => item.src === 'markmap-view.min.js')?.d3, 'Markmap loaded before D3');
    assert(order.find(item => item.src === 'auto-render.min.js')?.katex, 'Math auto-render loaded before KaTeX');
    await evaluate("window.__previewFixture.edit('no diagrams')"); await pause(500);
    assert(await frame('return DiagramHandler._instances.size') === 0, 'Markmap instances survived content replacement');
  });
  await run('incomplete-library-retries', async () => {
    await frame(`window.__incompleteLoads=0; const append=document.head.appendChild.bind(document.head);
      document.head.appendChild=function(s){if(s.src?.includes('mermaid.min.js')){
        window.__incompleteLoads++; if(window.__incompleteLoads>1)window.mermaid={initialize(){},render:async()=>({svg:'<svg><text>retry</text></svg>'})};
        queueMicrotask(()=>s.onload());return s;
      }return append(s)}; return null`);
    await evaluate("window.__previewFixture.edit('<pre><code class=language-mermaid>graph</code></pre>')"); await pause(500);
    assert(await frame('return window.__incompleteLoads') === 1, 'Incomplete library did not stop after first attempt');
    await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='重试预览').click()"); await pause(500);
    assert(await frame('return window.__incompleteLoads') === 2, 'Incomplete script was cached as successful, preventing retry');
    assert(await frame("return !!document.querySelector('#write svg')"), 'Incomplete library retry did not render');
  });
  await run('svg-and-image-map-navigation', async () => {
    await evaluate(`window.__previewFixture.edit('<svg><a xlink:href="https://example.invalid"><text>link</text></a></svg><map name="map"><area href="https://example.invalid"></map>')`); await pause(500);
    const prevented = await frame(`return Array.from(document.querySelectorAll('#write a,#write area')).map(link => {
      let caught = true;
      link.addEventListener('click', e => { caught = e.defaultPrevented; e.preventDefault(); });
      link.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      return caught;
    })`);
    assert(prevented.length === 2 && prevented.every(Boolean), 'SVG or image-map link bypassed navigation mediation');
  });
  await run('native-asset-uri-preserved', async () => {
    await evaluate(`window.__previewFixture.edit('<img src="asset://localhost/C:/preview-fixture/synthetic.png">')`); await pause(500);
    assert((await frame("return document.querySelector('#write img')?.getAttribute('src')"))?.startsWith('asset://'), 'Safe native asset URI was stripped');
  });
  return { passed: true, cases };
}

/** Diagram jobs belong to one render; libraries are shared, DOM and consent are not. */
const DiagramHandler = {
  _svgCache: new Map(),
  _cacheChars: 0,
  _mermaidQueue: Promise.resolve(),
  _instances: new Set(),
  _staging: new Set(),
  _generation: 0,

  sanitize(svg) {
    if (!window.PreviewSafety) throw new Error('Safe diagram renderer unavailable');
    return window.PreviewSafety.sanitize(svg, true);
  },
  cacheSvg(key, svg) {
    const cost = key.length + svg.length;
    // Huge sources/results bypass cache, and both keys and values count in budget.
    if (cost > 250000) return;
    if (this._svgCache.has(key)) {
      this._cacheChars -= key.length + this._svgCache.get(key).length;
      this._svgCache.delete(key);
    }
    this._svgCache.set(key, svg); this._cacheChars += cost;
    while (this._svgCache.size > 128 || this._cacheChars > 2000000) {
      const first = this._svgCache.keys().next().value;
      this._cacheChars -= first.length + this._svgCache.get(first).length;
      this._svgCache.delete(first);
    }
  },
  cachedSvg(key) {
    const svg = this._svgCache.get(key);
    if (svg !== undefined) { this._svgCache.delete(key); this._svgCache.set(key, svg); }
    return svg;
  },
  dispose() {
    ++this._generation;
    this._instances.forEach(instance => instance.destroy?.());
    this._instances.clear();
    this._staging.forEach(node => node.remove());
    this._staging.clear();
  },
  createLoadingIndicator(type) {
    const loader = document.createElement('div');
    loader.className = 'diagram-loading'; loader.textContent = `Rendering ${type}...`;
    loader.style.cssText = 'padding:10px;text-align:center;color:var(--text-color)';
    return loader;
  },
  showError(loader, message) { loader.textContent = message; loader.style.color = '#d33'; },
  async initializeAll(context = {}) {
    const generation = this._generation;
    const job = { scope: context.scope, current: () => generation === this._generation && (!context.current || context.current()) };
    window.ThemeConfig?.applyCSSVariables?.(this.isDarkMode());
    this.initializePlantUML(job);
    await Promise.all([this.initializeMermaid(job), this.initializeMarkmap(job)]);
    if (job.current()) this.updateContainerStyles();
  },
  async initializeMermaid(job = { current: () => true }) {
    if (!window.mermaid) return;
    const isDark = this.isDarkMode();
    const elements = document.querySelectorAll('#write .language-mermaid');
    await Promise.all(Array.from(elements).map(element => {
      if (element.dataset.processed === 'true') return;
      const source = element.textContent || '';
      if (!source.trim()) return;
      const key = JSON.stringify([isDark, source]);
      const cached = this.cachedSvg(key);
      if (cached !== undefined && job.current()) {
        element.innerHTML = this.sanitize(cached);
        element.dataset.processed = 'true'; return;
      }
      // Mermaid configuration is global. Serialize initialize+render so a queued
      // old-theme request cannot race another render's configuration.
      const render = async () => {
        if (!job.current() || !element.isConnected) return;
        const loader = this.createLoadingIndicator('Mermaid');
        element.before(loader);
        const staging = document.createElement('div');
        staging.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
        document.body.append(staging); this._staging.add(staging);
        try {
          window.mermaid.initialize({ ...window.ThemeConfig?.getMermaidConfig(isDark), securityLevel: 'strict', startOnLoad: false, suppressErrorRendering: true });
          const { svg } = await window.mermaid.render('mermaid-' + crypto.randomUUID(), source, staging);
          if (!job.current() || !element.isConnected) return;
          const safe = this.sanitize(svg);
          this.cacheSvg(key, safe);
          element.innerHTML = safe;
          element.dataset.processed = 'true'; element.dataset.mermaidRendered = 'true';
        } catch (error) {
          if (job.current() && element.isConnected) {
            element.dataset.mermaidRendered = 'failed';
            element.closest('pre')?.classList.add('mermaid-source-fallback');
            window.PreviewBridge?.send({ type: 'preview-error', message: 'Mermaid rendering failed' }, job.scope);
          }
        } finally { loader.remove(); staging.remove(); this._staging.delete(staging); }
      };
      this._mermaidQueue = this._mermaidQueue.then(render, render);
      return this._mermaidQueue;
    }));
  },

  initializePlantUML(job = { current: () => true }) {
    // No encoder loading, polling or network traffic before a parent UI approval.
    document.querySelectorAll('#write .language-plantuml').forEach((code, index) => {
      if (code.dataset.processed === 'true' || code.parentNode.querySelector('.plantuml-request')) return;
      const source = code.textContent;
      const button = document.createElement('button');
      button.className = 'plantuml-request';
      button.textContent = '请求在线渲染 PlantUML（将发送此图源码）';
      button.addEventListener('click', () => {
        if (job.current() && code.isConnected) window.PreviewBridge?.send({ type: 'plantuml-request', index, source }, job.scope);
      });
      code.before(button);
    });
  },
  processPlantumlElement(code, job, authorizedSource) {
    if (!job?.current() || !code.isConnected || code.textContent !== authorizedSource || code.dataset.processed === 'true' || !window.plantumlEncoder) return;
    code.dataset.processed = 'true';
    code.parentNode.querySelector('.plantuml-request')?.remove();
    const loader = this.createLoadingIndicator('PlantUML'); code.before(loader);
    const image = document.createElement('img'); image.className = 'plantuml-image';
    image.referrerPolicy = 'no-referrer';
    const themed = (window.ThemeConfig?.getPlantUMLSkinparams(this.isDarkMode()) || '') + '\n' + authorizedSource;
    image.onload = () => {
      loader.remove();
      if (!job.current() || !code.isConnected) { image.remove(); return; }
      code.style.display = 'none'; image.style.cssText = 'display:block;max-width:100%;height:auto;margin:0 auto';
    };
    image.onerror = () => {
      image.remove(); loader.remove();
      if (!job.current() || !code.isConnected) return;
      code.dataset.processed = 'false';
      this.initializePlantUML(job);
      window.PreviewBridge?.send({ type: 'preview-error', message: 'PlantUML request failed; request this diagram again to retry' }, job.scope);
    };
    code.before(image);
    // This is the only external PlantUML request site. Authorization is consumed
    // for this code node, not stored by document, theme, source hash or session.
    image.src = 'https://www.plantuml.com/plantuml/svg/~1' + window.plantumlEncoder.encode(themed);
  },

  async initializeMarkmap(job = { current: () => true }) {
    const elements = document.querySelectorAll('#write .language-markmap');
    if (!elements.length) return;
    if (!window.markmap?.Transformer || !window.markmap?.Markmap) throw new Error('Markmap unavailable');
    for (const element of elements) {
      if (!job.current() || !element.isConnected || element.dataset.markmapRendered === 'true') continue;
      const transformer = new window.markmap.Transformer();
      const { root } = transformer.transform(element.textContent);
      // Do not call autoLoader/getAssets: document features must never inject JS.
      // Sanitize every HTML label before D3/Markmap puts it into a foreignObject.
      const clean = node => {
        node.content = window.PreviewSafety.sanitize(node.content || '');
        node.children?.forEach(clean);
      };
      clean(root);
      if (!job.current()) return;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.style.cssText = 'width:100%;height:450px';
      element.replaceChildren(svg);
      const instance = window.markmap.Markmap.create(svg, { duration: 0, autoFit: true }, root);
      this._instances.add(instance);
      element.dataset.markmapRendered = 'true'; element.classList.add('markmap');
      if (!job.current()) { instance.destroy?.(); this._instances.delete(instance); }
    }
  },
  updateContainerStyles() {
    document.querySelectorAll('.plantuml-image').forEach(el => el.closest('pre')?.classList.add('plantuml-image-container'));
    document.querySelectorAll('.language-mermaid').forEach(el => el.closest('pre')?.classList.add('mermaid-image-container'));
    document.querySelectorAll('.language-markmap').forEach(el => el.closest('pre')?.classList.add('markmap-image-container'));
  },

  initializeMarkmapForPPT() {
    let markMapList = document.querySelectorAll('.language-markmap');

    // Fallback: inspect generic code blocks for ```markmap fences
    if (markMapList.length === 0) {
      const codeBlocks = document.querySelectorAll('pre code');
      codeBlocks.forEach(block => {
        const text = block.textContent || '';
        if (text.trim().startsWith('markmap') || text.includes('```markmap')) {
          block.classList.add('language-markmap');
        }
      });
      markMapList = document.querySelectorAll('.language-markmap');
    }

    markMapList.forEach((item, i) => {
      this.processMarkmapForPPT(item, i);
    });
  },

  processMarkmapForPPT(item, index) {
    const markMapName = 'markmap-' + index;
    const markMapChildClass = '.' + markMapName + ' .markmap';

    let heightAttr = item.textContent.match(/\<\!\-\-markmap-height\=(\S*)\-\-\>/);

    const content = item.textContent || '';
    const lines = content.split('\n').filter(line => line.trim());
    const maxDepth = Math.max(0, ...lines.map(line => {
      const match = line.match(/^(\s*)([-*+]|\d+\.)/);
      return match ? Math.floor(match[1].length / 2) : 0;
    }));

    let autoHeight = Math.min(400, Math.max(250, 250 + maxDepth * 30 + lines.length * 15));
    let height = autoHeight + 'px';

    if (heightAttr && heightAttr.length > 0 && !isNaN(heightAttr[1])) {
      height = heightAttr[1] + 'px';
    }

    item.classList.add('markmap');
    item.classList.add(markMapName);

    setTimeout(() => {
      const markMapItem = document.querySelector('.' + markMapName);
      if (markMapItem) {
        markMapItem.style.maxHeight = height;
        markMapItem.style.height = height;

        setTimeout(() => {
          const markMapItemChild = document.querySelector(markMapChildClass);
          if (markMapItemChild) {
            markMapItemChild.style.height = height;

            if (window.markmap && markMapItemChild.markmap) {
              markMapItemChild.markmap.fit();
            }
          }
        }, 50);
      }
    }, 10);
  },
  isDarkMode() { return window.ThemeConfig?.isDarkMode?.() || 'CUSTOM_CSS' === 'darkmode'; }
};
window.DiagramHandler = DiagramHandler;

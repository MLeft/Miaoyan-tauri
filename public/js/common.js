/**
 * MiaoYan Common Utilities
 */

const MiaoYanCommon = {
  isDarkMode() {
    // Delegate to ThemeConfig for consistent dark mode detection
    return window.ThemeConfig?.isDarkMode?.() || 'CUSTOM_CSS' === 'darkmode';
  },

  // Utility: Apply styles to multiple elements
  applyStylesToElements(selector, styles) {
    document.querySelectorAll(selector).forEach(el => {
      Object.assign(el.style, styles);
    });
  },

  // Utility: Set attributes to multiple elements
  setAttributesToElements(selector, attributes) {
    document.querySelectorAll(selector).forEach(el => {
      Object.entries(attributes).forEach(([key, value]) => {
        el.setAttribute(key, value);
      });
    });
  },

  setupTextSelection() {
    function getSelectionAndSendMessage() {
      const txt = document.getSelection().toString();
      window.webkit?.messageHandlers.newSelectionDetected?.postMessage(txt);
    }

    document.onmouseup = getSelectionAndSendMessage;
    document.onkeyup = getSelectionAndSendMessage;
    document.oncontextmenu = getSelectionAndSendMessage;
  },

  setupCheckboxes() {
    document.querySelectorAll('input').forEach(input => {
      input.disabled = true;

      const parent = input.parentNode;
      const grandParent = parent?.parentNode;

      if (parent?.tagName === 'P' && grandParent?.tagName === 'LI') {
        grandParent.parentNode?.classList.add('cb');
      } else if (parent?.tagName === 'LI') {
        grandParent?.classList.add('cb');
      }
    });
  },

  setupInteractiveCheckboxes() {
    this.setupCheckboxes();

    const checkboxList = document.querySelectorAll('input[type=checkbox]');
    checkboxList.forEach((checkbox, i) => {
      if (checkbox.parentNode.nodeName === 'LI' && checkbox.hasAttribute('checked')) {
        checkbox.parentNode.classList.add('strike');
      }

      checkbox.disabled = false;
      checkbox.dataset.checkbox = i;

      checkbox.addEventListener('click', (event) => {
        this.handleCheckboxClick(event.target);
      });
    });
  },

  handleCheckboxClick(element) {
    if (element.parentNode.nodeName === 'LI') {
      element.parentNode.classList.remove('strike');
    }

    const id = element.dataset.checkbox;
    // Notify parent frame (Tauri WebView) about checkbox toggle
    window.parent.postMessage({ type: 'checkbox-toggle', index: id }, '*');

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.checkbox = id;

    if (!element.hasAttribute('checked')) {
      input.defaultChecked = true;
      if (element.parentNode.nodeName === 'LI') {
        element.parentNode.classList.add('strike');
      }
    }

    element.parentNode.replaceChild(input, element);
    input.addEventListener('click', () => {
      this.handleCheckboxClick(input);
    });
  },

  // IntersectionObserver 单例：预览每次渲染都会调 optimizeImages，
  // 若每次 new 一个且不 disconnect，observer 会随按键无限累积（内存/调度泄漏）。
  // 提升为模块级单例，observe 前先断开旧观察关系
  _imageObserver: null,

  optimizeImages() {
    const allImages = document.querySelectorAll('img');

    // Configuration
    const INTERSECTION_MARGIN = '400px'; // Start loading 400px before viewport for smoother experience

    allImages.forEach((img) => {
      img.style.maxWidth = '100%';
      img.style.height = 'auto';

      // Swift already marked lazy images with class="lazy-image" and data-src
      // Just ensure eager images have the attribute set
      if (!img.classList.contains('lazy-image')) {
        img.setAttribute('loading', 'eager');
      }
    });

    // Intersection Observer for aggressive lazy loading
    if ('IntersectionObserver' in window) {
      const lazyImages = document.querySelectorAll('img.lazy-image');
      if (lazyImages.length === 0) return;

      if (!this._imageObserver) {
        this._imageObserver = new IntersectionObserver((entries, observer) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              const img = entry.target;
              if (img.dataset.src) {
                img.src = img.dataset.src;
                img.classList.remove('lazy-image');
                delete img.dataset.src;
                observer.unobserve(img);

                // Re-initialize Lightense for this image after it loads
                if (window.Lightense && (img.closest('#write') || img.parentElement?.tagName === 'P' || img.closest('table'))) {
                  img.addEventListener('load', () => {
                    window.Lightense([img], {
                      background: MiaoYanCommon.isDarkMode() ? 'rgba(33, 38, 43, .8)' : 'rgba(255, 255, 255, .8)',
                    });
                  }, { once: true });
                }
              }
            }
          });
        }, {
          rootMargin: INTERSECTION_MARGIN,
          threshold: 0.01
        });
      } else {
        // 复用单例：先丢弃指向旧 DOM（已被 innerHTML 替换）的观察关系
        this._imageObserver.disconnect();
      }

      lazyImages.forEach(img => {
        this._imageObserver.observe(img);
      });
    } else {
      // Fallback for older browsers (shouldn't happen on macOS 11.5+)
      document.querySelectorAll('img.lazy-image').forEach(img => {
        if (img.dataset.src) {
          img.src = img.dataset.src;
          delete img.dataset.src;
        }
      });
    }
  },

  setupImageZoom() {
    const zoomImgs = document.querySelectorAll('#write>img, #write>p>img, #write>table img');
    if (zoomImgs.length > 0 && window.Lightense) {
      window.Lightense(zoomImgs, {
        background: this.isDarkMode() ? 'rgba(33, 38, 43, .8)' : 'rgba(255, 255, 255, .8)',
      });
    }
  },

  setupHeaderAnchors() {
    // Generate unique IDs for headings, handling duplicates
    const usedIds = new Set();
    document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
      // textContent 不触发布局计算，比 innerText 便宜得多
      let baseId = h.textContent.trim();
      let id = baseId;
      let counter = 1;

      while (usedIds.has(id)) {
        id = `${baseId}-${counter}`;
        counter++;
      }

      h.id = id;
      usedIds.add(id);
    });

    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
      anchor.addEventListener('click', function (e) {
        e.preventDefault();
        document.querySelector(decodeURIComponent(this.getAttribute('href')))?.scrollIntoView({
          behavior: 'smooth',
        });
      });
    });
  },

  setupFootnoteLinks() {
    var write = document.getElementById('write');
    if (!write) return;
    // #write 是持久节点，每次渲染重复 addEventListener 会累积重复监听器；
    // 用标记保证只绑定一次
    if (write.dataset.footnoteBound === '1') return;
    write.dataset.footnoteBound = '1';

    write.addEventListener('click', function(e) {
      var target = e.target.closest('a');
      if (!target) return;

      var href = target.getAttribute('href');
      if (!href || !href.startsWith('#')) return;

      // Only intercept footnote reference and backref links
      var isFootnoteRef = target.closest('.footnote-reference') !== null;
      var isFootnoteBackref = target.classList.contains('footnote-backref');
      if (!isFootnoteRef && !isFootnoteBackref) return;

      e.preventDefault();
      var id = href.substring(1);
      var dest = document.getElementById(id);
      if (dest) {
        dest.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  },

  // 代码块高亮缓存（内容 hash → 高亮后 HTML）：预览每次更新都重建 innerHTML，
  // hljs.highlightAll 会重复高亮未变更的代码块，大文档/多代码块时开销显著
  _hlCache: new Map(),
  _hlHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  },

  initializeCore() {
    if (window.hljs) {
      document.querySelectorAll('pre code').forEach((block) => {
        if (block.dataset.highlighted === 'yes') return;
        const raw = block.textContent;
        const key = this._hlHash(raw);
        const cached = this._hlCache.get(key);
        if (cached) {
          block.innerHTML = cached;
          block.classList.add('hljs');
          block.dataset.highlighted = 'yes';
        } else {
          try {
            hljs.highlightElement(block);
            this._hlCache.set(key, block.innerHTML);
          } catch (e) {
            /* 高亮失败保留原文 */
          }
        }
      });
      // 防止缓存无限增长
      if (this._hlCache.size > 500) this._hlCache.clear();
    }

    this.escapeCurrencyLikeMath();

    // 短路：文档不含 ':'（emoji shortcode 的必要字符）时跳过全文本节点遍历；
    // _hasEmojiHint 由 preview.html setContent 在 html 字符串上预判
    if (window.EmojiConvertor && window._hasEmojiHint !== false) {
      const writeElement = document.getElementById('write');
      const emoji = new EmojiConvertor();

      // Use TreeWalker to replace emoji only in text nodes, avoiding code blocks
      const walker = document.createTreeWalker(
        writeElement,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function(node) {
            // Skip text nodes inside code or pre elements
            let parent = node.parentElement;
            while (parent && parent !== writeElement) {
              if (parent.tagName === 'CODE' || parent.tagName === 'PRE') {
                return NodeFilter.FILTER_REJECT;
              }
              parent = parent.parentElement;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      const nodesToReplace = [];
      let node;
      while (node = walker.nextNode()) {
        if (/:[^:\s]*(?:::[^:\s]*)*:/.test(node.textContent)) {
          nodesToReplace.push(node);
        }
      }

      // Replace emoji in collected text nodes
      nodesToReplace.forEach(textNode => {
        const replacedHTML = emoji.replace_colons(textNode.textContent);
        if (replacedHTML !== textNode.textContent) {
          const span = document.createElement('span');
          span.innerHTML = replacedHTML;
          textNode.parentNode.replaceChild(span, textNode);
        }
      });
    }
  },

  escapeCurrencyLikeMath() {
    // 短路：本函数是 KaTeX 的预处理，文档无数学时（_hasMathHint 由
    // preview.html setContent 在字符串上预判）无需遍历全部文本节点
    if (window._hasMathHint === false) return;
    const writeElement = document.getElementById('write');
    if (!writeElement) {
      return;
    }

    const walker = document.createTreeWalker(
      writeElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.textContent.includes('$')) {
            return NodeFilter.FILTER_REJECT;
          }

          let parent = node.parentElement;
          while (parent && parent !== writeElement) {
            const tagName = parent.tagName;
            if (
              tagName === 'CODE' ||
              tagName === 'PRE' ||
              tagName === 'SCRIPT' ||
              tagName === 'STYLE' ||
              parent.classList.contains('katex') ||
              parent.classList.contains('skip-math-dollar')
            ) {
              return NodeFilter.FILTER_REJECT;
            }
            parent = parent.parentElement;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodesToUpdate = [];
    let currentNode;
    while ((currentNode = walker.nextNode())) {
      nodesToUpdate.push(currentNode);
    }

    const currencyRegex = /^\$([0-9]+(?:[.,][0-9]+)?)(?=$|[^0-9A-Za-z+\-*/=<>^_\\])/;

    nodesToUpdate.forEach(node => {
      const text = node.textContent;
      if (!text.includes('$')) {
        return;
      }

      const fragment = document.createDocumentFragment();
      let index = 0;
      let lastIndex = 0;
      let replaced = false;

      while (index < text.length) {
        const char = text[index];

        if (char === '\\' && index + 1 < text.length && text[index + 1] === '$') {
          index += 2;
          continue;
        }

        if (char === '$') {
          const remaining = text.slice(index);
          const match = remaining.match(currencyRegex);
          if (match) {
            if (index > lastIndex) {
              fragment.appendChild(document.createTextNode(text.slice(lastIndex, index)));
            }
            const span = document.createElement('span');
            span.className = 'skip-math-dollar';
            span.textContent = match[0];
            fragment.appendChild(span);
            index += match[0].length;
            lastIndex = index;
            replaced = true;
            continue;
          }
        }

        index += 1;
      }

      if (!replaced) {
        return;
      }

      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }

      node.parentNode?.replaceChild(fragment, node);
    });
  },

  onDOMReady(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback);
    } else {
      callback();
    }
  }
};

// TOC configuration constants
const TOC_CONFIG = {
  MIN_HEADINGS: 2,
  MIN_SCREEN_WIDTH: 600,
  AUTO_HIDE_DELAY: 3000,
  INIT_DELAY: 200,
  SCROLL_OFFSET_TOP: 60,
  SCROLL_OFFSET_BOTTOM: 80,
  SCROLL_DEBOUNCE: 100
};

(function() {
  function initTOC() {
    const nav = document.querySelector('.toc-nav');
    const trigger = document.querySelector('.toc-hover-trigger');
    const tocContainer = document.querySelector('.toc-content');
    const pinBtn = document.querySelector('.toc-pin-btn');
    if (!nav || !trigger || !tocContainer) return;

    // Check if we have enough headings (only count h1-h3 for TOC)
    const headings = document.querySelectorAll('#write h1, #write h2, #write h3');
    if (headings.length < TOC_CONFIG.MIN_HEADINGS) {
      trigger.style.display = 'none';
      return;
    }

    // Initialize tocbot (only show 3 levels: h1, h2, h3)
    if (window.tocbot) {
      tocbot.init({
        tocSelector: '.toc-content',
        contentSelector: '#write',
        headingSelector: 'h1, h2, h3',
        hasInnerContainers: true,
        collapseDepth: 3,
        scrollSmooth: true,
        scrollSmoothDuration: 200,
        headingsOffset: 80,
        ignoreHiddenElements: true
      });
    }

    let fadeTimer = null;
    let scrollTimeout = null;
    let isPinned = localStorage.getItem('toc-pinned') === 'true';

    const startAutoHideTimer = () => {
      if (isPinned) return;
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(() => {
        trigger.style.opacity = '0';
      }, TOC_CONFIG.AUTO_HIDE_DELAY);
    };

    const cancelAutoHideTimer = () => {
      clearTimeout(fadeTimer);
      trigger.style.opacity = '';
    };

    const show = () => {
      nav.classList.add('active');
      trigger.classList.add('hidden');
      cancelAutoHideTimer();
    };

    const hide = () => {
      if (isPinned) return;
      nav.classList.remove('active');
      trigger.classList.remove('hidden');
    };

    // Auto-scroll active link into view within TOC panel
    const scrollToActive = () => {
      const activeLink = tocContainer.querySelector('.is-active-link');
      if (!activeLink || !nav.classList.contains('active')) return;

      const linkTop = activeLink.offsetTop;
      const navScroll = nav.scrollTop;
      const navHeight = nav.clientHeight;

      if (linkTop < navScroll + TOC_CONFIG.SCROLL_OFFSET_TOP ||
          linkTop > navScroll + navHeight - TOC_CONFIG.SCROLL_OFFSET_BOTTOM) {
        nav.scrollTo({ top: linkTop - TOC_CONFIG.SCROLL_OFFSET_TOP, behavior: 'smooth' });
      }
    };

    const observer = new MutationObserver(() => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(scrollToActive, TOC_CONFIG.SCROLL_DEBOUNCE);
    });

    observer.observe(tocContainer, { subtree: true, attributeFilter: ['class'] });

    // Pin button handler
    if (pinBtn) {
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isPinned = !isPinned;
        localStorage.setItem('toc-pinned', isPinned);

        if (isPinned) {
          nav.classList.add('pinned');
          show();
        } else {
          nav.classList.remove('pinned');
          hide();
          startAutoHideTimer();
        }
      });
    }

    // Initialize pinned state
    if (isPinned) {
      nav.classList.add('pinned');
      show();
    }

    trigger.addEventListener('mouseenter', show);
    nav.addEventListener('mouseenter', show);

    trigger.addEventListener('mouseover', () => {
      cancelAutoHideTimer();
      trigger.style.opacity = '0.2';
    });

    document.addEventListener('mousedown', (e) => {
      if (nav.classList.contains('active') &&
          !nav.contains(e.target) &&
          !trigger.contains(e.target)) {
        hide();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && nav.classList.contains('active')) {
        hide();
      }
    });

    const handleResize = () => {
      trigger.style.display = window.innerWidth < TOC_CONFIG.MIN_SCREEN_WIDTH ? 'none' : '';
      if (window.innerWidth < TOC_CONFIG.MIN_SCREEN_WIDTH) hide();
    };
    window.addEventListener('resize', handleResize);
    handleResize();

    if (!isPinned) {
      startAutoHideTimer();
    }
  }

  // Wait for tocbot to be available and render TOC
  MiaoYanCommon.onDOMReady(() => {
    setTimeout(() => {
      if (window.tocbot && document.querySelector('.toc-nav')) {
        initTOC();
      }
    }, TOC_CONFIG.INIT_DELAY);
  });
})();

window.MiaoYanCommon = MiaoYanCommon;

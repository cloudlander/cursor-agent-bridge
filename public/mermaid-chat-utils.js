(() => {
  'use strict';

  const MERMAID_BLOCKED_SVG_TAGS = new Set(['script', 'iframe', 'object', 'embed']);

  const SEQ_ARROW = '(?:<<)?--?(?:>>|>|x|\\))';
  const SEQ_ID = '[^\\s:<>+\\-]+';
  const SEQ_CHAIN_RE = new RegExp(
    `^(\\s*)(${SEQ_ID})((?:\\s*${SEQ_ARROW}\\s*[+\\-]?${SEQ_ID}){2,})\\s*:(.*)$`,
  );
  const SEQ_HOP_RE = new RegExp(`\\s*(${SEQ_ARROW})\\s*([+\\-]?${SEQ_ID})`, 'g');

  /** Models sometimes write `A-->>B-->>C: text`, which Mermaid rejects; emit one message per hop. */
  function splitChainedSequenceMessage(line) {
    const m = SEQ_CHAIN_RE.exec(line);
    if (!m) return line;
    const [, indent, first, chain, text] = m;
    const out = [];
    let from = first;
    for (const [, arrow, to] of chain.matchAll(SEQ_HOP_RE)) {
      out.push(`${indent}${from}${arrow}${to}:${text}`);
      from = to.replace(/^[+-]/, '');
    }
    return out.join('\n');
  }

  function prepareMermaidSource(source) {
    const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
    const first = lines.find((l) => l.trim() && !l.trim().startsWith('%%')) || '';
    const isSequence = /^sequenceDiagram\b/i.test(first.trim());
    return lines
      .map((line) => {
        const trimmed = line.trimStart();
        if (/^participant\s/i.test(trimmed) || /^actor\s/i.test(trimmed)) {
          return line.replace(/<br\s*\/?>/gi, ' ');
        }
        if (/^Note\s+(over|left of|right of)/i.test(trimmed) || /^title\s/i.test(trimmed)) {
          return line.replace(/<br\s*\/?>/gi, ' ');
        }
        // Sequence messages natively support <br/>; a real newline would break the statement.
        if (isSequence) return splitChainedSequenceMessage(line);
        if (/(-->|--|==>|===)/.test(line) && /[|"].*<br/i.test(line)) {
          return line.replace(/<br\s*\/?>/gi, ' ');
        }
        return line.replace(/<br\s*\/?>/gi, '\n');
      })
      .join('\n');
  }

  /** Mermaid HTML labels emit void tags like <br>; XML parsing needs them self-closed. */
  function normalizeMermaidSvgForXml(svg) {
    return String(svg)
      .replace(/<(br|hr|img|wbr)\b([^>]*?)\s*\/?>/gi, '<$1$2 />')
      .replace(/&nbsp;/g, '&#160;');
  }

  function sanitizeMermaidSvg(svg) {
    if (!svg || typeof svg !== 'string') return '';
    const doc = new DOMParser().parseFromString(normalizeMermaidSvgForXml(svg), 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg') return '';
    const walk = (node) => {
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (MERMAID_BLOCKED_SVG_TAGS.has(tag)) {
        node.remove();
        return;
      }
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        const val = attr.value.trim().toLowerCase();
        if (name.startsWith('on')) {
          node.removeAttribute(attr.name);
        } else if ((name === 'href' || name === 'xlink:href') && /^(javascript|vbscript|data:)/.test(val)) {
          node.removeAttribute(attr.name);
        }
      }
      for (const child of [...node.childNodes]) walk(child);
    };
    walk(root);
    return new XMLSerializer().serializeToString(root);
  }

  function isMeaningfulMermaidSvg(svg) {
    if (!svg || svg.length < 40) return false;
    return /<(path|line|polyline|polygon|rect|circle|ellipse|text|tspan|g)\b/i.test(svg);
  }

  function getMermaidSvgNaturalSize(svg) {
    if (!svg) return { width: 400, height: 300 };
    const vb = svg.viewBox && svg.viewBox.baseVal;
    if (vb && vb.width > 0 && vb.height > 0) {
      return { width: vb.width, height: vb.height };
    }
    const w = parseFloat(svg.getAttribute('width'));
    const h = parseFloat(svg.getAttribute('height'));
    if (w > 0 && h > 0) return { width: w, height: h };
    try {
      const bbox = svg.getBBox();
      if (bbox.width > 0 && bbox.height > 0) {
        return { width: bbox.width, height: bbox.height };
      }
    } catch {
      /* not attached */
    }
    return { width: 400, height: 300 };
  }

  /** Scale up small diagrams to fill the viewport; keep natural size when larger (scroll). */
  function computeMermaidLightboxLayout(natW, natH, availW, availH) {
    const aw = Math.max(1, availW);
    const ah = Math.max(1, availH);
    const scaleFit = Math.min(aw / natW, ah / natH);
    const scale = scaleFit >= 1 ? scaleFit : 1;
    const displayW = natW * scale;
    const displayH = natH * scale;
    return {
      displayW,
      displayH,
      wrapW: Math.max(aw, displayW),
      wrapH: Math.max(ah, displayH),
    };
  }

  function layoutMermaidLightbox(host, scrollEl) {
    const svg = host && host.querySelector && host.querySelector('svg');
    if (!svg || !scrollEl) return;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(scrollEl) : null;
    const padX = style
      ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      : 0;
    const padY = style
      ? parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      : 0;
    const availW = Math.max(1, scrollEl.clientWidth - padX);
    const availH = Math.max(1, scrollEl.clientHeight - padY);
    const { width: natW, height: natH } = getMermaidSvgNaturalSize(svg);
    const { displayW, displayH, wrapW, wrapH } = computeMermaidLightboxLayout(
      natW,
      natH,
      availW,
      availH,
    );
    svg.style.width = `${displayW}px`;
    svg.style.height = `${displayH}px`;
    svg.style.display = 'block';
    svg.style.flexShrink = '0';
    svg.style.maxWidth = 'none';
    host.style.width = `${wrapW}px`;
    host.style.height = `${wrapH}px`;
    host.style.minWidth = `${wrapW}px`;
    host.style.minHeight = `${wrapH}px`;
    host.style.boxSizing = 'border-box';
    host.style.display = 'flex';
    host.style.alignItems = 'center';
    host.style.justifyContent = 'center';
  }

  window.ChatMermaidUtils = {
    prepareMermaidSource,
    sanitizeMermaidSvg,
    isMeaningfulMermaidSvg,
    getMermaidSvgNaturalSize,
    computeMermaidLightboxLayout,
    layoutMermaidLightbox,
    MERMAID_BLOCKED_SVG_TAGS,
  };
})();

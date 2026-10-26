/**
 * QQ 陪伴记忆 · 浏览器侧入口。
 *
 * 只做两件事：把侧栏入口注册到 DSH 面板列表，并在主面板里承载服务端提供的
 * 独立管理页（`/api/qq-companion-memory/v1/page`）。页面本体是完整 HTML 文档，
 * 自带外部 CSS/JS，不经过壳层渲染，也不在这里拼装任何业务数据。
 *
 * 依赖说明：react 属于平台外部（宿主模块表已提供），因此不写入插件依赖。
 * 页面地址使用「文档相对」形式，兼容 DSH 部署在子路径（如 /dsh/）的情况。
 */

import { createElement } from 'react';

export const name = 'qq-companion-memory';
export const inject = ['slots'];

/** 侧栏面板 id，同时作为 main 面板 key。 */
export const PANEL_ID = 'qq-companion-memory';
/** 页面路由（文档相对；带前导斜杠会在子路径部署下打偏）。 */
export const PAGE_URL = 'api/qq-companion-memory/v1/page';
/** 侧栏标签。 */
export const PANEL_LABEL = '记忆管理';

const SVG_NS = 'http://www.w3.org/2000/svg';

function MemoryPanelIcon(props) {
  const size = props && typeof props.size === 'number' ? props.size : 16;
  return createElement(
    'svg',
    {
      xmlns: SVG_NS,
      viewBox: '0 0 16 16',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      'data-dsh-panel-entry': PANEL_ID,
    },
    createElement('path', { d: 'M3.4 3.2h5.9c.9 0 1.6.7 1.6 1.6v8.3H5c-.9 0-1.6-.7-1.6-1.6V3.2z' }),
    createElement('path', { d: 'M5.7 6.1h3.2M5.7 8.5h3.2' }),
    createElement('path', { d: 'M10.9 5.7h1c.4 0 .7.3.7.7v6.1c0 .4-.3.7-.7.7h-1' }),
  );
}

function MemoryPanel() {
  return createElement(
    'div',
    {
      'data-dsh-qq-companion-memory-page': '',
      style: {
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: '60vh',
      },
    },
    createElement('iframe', {
      src: PAGE_URL,
      title: 'QQ 陪伴记忆管理',
      style: {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
        border: '0',
        background: 'transparent',
      },
    }),
  );
}

export function apply(ctx) {
  // 两个槽位都由壳层包声明，各自用 inject 等待：壳层没有该槽时不报错，只是不出现入口。
  const disposers = [];

  disposers.push(
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 100,
          label: () => PANEL_LABEL,
        },
        MemoryPanelIcon,
      ),
    ),
  );

  disposers.push(
    ctx.slots.inject('main', () =>
      ctx.slots.register(
        {
          name: 'main',
          key: PANEL_ID,
        },
        MemoryPanel,
      ),
    ),
  );

  ctx.effect(
    () => () => {
      for (const dispose of disposers.splice(0)) {
        if (typeof dispose === 'function') dispose();
      }
    },
    'qq-companion-memory: 侧栏与页面注册',
  );
}

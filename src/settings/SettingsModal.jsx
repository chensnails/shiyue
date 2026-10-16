/* 设置弹层 React 组件（v1.3.0 起外壳 React 化）。
 *
 * 渐进式迁移策略（与命令面板一致的混合期方案）：
 * - 弹层外壳（遮罩 / 标题 / tab 栏 / 关闭）由 React 渲染；
 * - 「外观 / 模型 / 关于」三个面板为 React 组件（本目录 AppearancePane /
 *   ModelPane / AboutPane）；
 * - 其余面板（数据源 / 账号 / 状态）暂由旧 DOM 承接：它们装在
 *   index.html 的 #legacyPanes 隐藏容器里，选中对应 tab 时由本组件搬进
 *   tab-pane-legacy 插槽（appendChild 移动节点，旧监听与 ID 全部保留，
 *   行为零变化），随 P2c~P2d 逐个迁移后移除。
 * - 旧 app.js 的 openSettings/closeSettings 委托给本组件注册的宿主；
 *   tab 切换副作用（loaders / 状态轮询）走 window.shiyue.settingsTabEffect。
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AboutPane } from './AboutPane.jsx';
import { AppearancePane } from './AppearancePane.jsx';
import { ModelPane } from './ModelPane.jsx';

const TABS = [
  ['source', '数据源'],
  ['model', '模型'],
  ['account', '账号'],
  ['appearance', '外观'],
  ['status', '状态'],
  ['about', '关于'],
];
// 管理员专属 tab（与管理端约定一致；模型配置每用户独立，普通用户也能配）
const ADMIN_TABS = ['status'];
// 尚未 React 化的面板（P2b 起模型已迁出）：由旧 DOM 经 legacy-slot 承接
const LEGACY_TABS = ['source', 'account', 'status'];

const S = () => (typeof window !== 'undefined' ? window.shiyue : null);
const isAdminNow = () => !!(S() && S().isAdmin && S().isAdmin());

/** 把 slot 里的旧面板还回 #legacyPanes 隐藏容器（移动节点，旧监听/ID 全保留） */
const stashLegacyPanes = (slot, stash) => {
  if (!slot || !stash) return;
  [...slot.children].forEach((el) => {
    el.hidden = true;
    stash.appendChild(el);
  });
};

export function SettingsModal() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('source');
  const [summary, setSummary] = useState('');
  const [admin, setAdmin] = useState(isAdminNow);
  const slotRef = useRef(null);

  // 宿主注册：旧 app 的 openSettings/closeSettings 委托到这里
  useEffect(() => {
    const host = {
      open(t) {
        const adm = isAdminNow();
        setAdmin(adm);
        let next = t || 'source';
        if (ADMIN_TABS.indexOf(next) >= 0 && !adm) next = 'source';   // 普通用户看不到管理 tab
        setSummary((S() && S().getSettingsSummary && S().getSettingsSummary()) || '');
        setTab(next);
        setOpen(true);
      },
      close() { setOpen(false); },
      setSummary,
      setAdminFlag(a) { setAdmin(!!a); },
    };
    window.__settingsHost = host;
    return () => { delete window.__settingsHost; };
  }, []);

  // 开合状态同步给旧代码（Escape 关闭 / j/k 键盘导航 / 自动刷新的判据）
  useEffect(() => {
    window.__settingsOpen = open;
    return () => { window.__settingsOpen = false; };
  }, [open]);

  // 打开时锁背景滚动（计数式，与图片灯箱共存的旧约定兼容），关闭时解锁
  useEffect(() => {
    const s = S();
    if (!open) return;
    if (s && s.lockPageScroll) s.lockPageScroll();
    return () => { if (s && s.unlockPageScroll) s.unlockPageScroll(); };
  }, [open]);

  // 关闭时停掉状态页轮询（切 tab 的启停由 settingsTabEffect 负责）
  useEffect(() => {
    if (open) return;
    const s = S();
    if (s && s.stopStatusPolling) s.stopStatusPolling();
  }, [open]);

  // tab 切换副作用：旧 app 加载对应表单 / 启停状态轮询；
  // about / appearance 已 React 化，由组件自行加载（settingsTabEffect 内跳过）
  useEffect(() => {
    if (!open) return;
    const s = S();
    if (s && s.settingsTabEffect) s.settingsTabEffect(tab);
  }, [open, tab]);

  // legacy 面板：slot 常驻挂载（非 legacy tab 下仅隐藏，不销毁旧 DOM），
  // 选中时把旧面板搬进插槽；切走 / 关闭时还回 #legacyPanes 隐藏容器。
  // React 只在 ref 卸载时清空 slotRef，节点本身仍可达，故还回动作对
  // 「关闭弹层导致 slot 随 modal 一起卸载」同样有效。
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const stash = document.getElementById('legacyPanes');
    const isLegacy = open && LEGACY_TABS.indexOf(tab) >= 0;
    if (isLegacy) {
      const s = S();
      const el = s && s.getLegacySettingsPane ? s.getLegacySettingsPane(tab) : null;
      if (el && slot) {
        stashLegacyPanes(slot, stash);          // 先还上一个，避免 slot 里堆多个
        el.hidden = false;
        slot.appendChild(el);
      }
    } else {
      stashLegacyPanes(slot, stash);
    }
  }, [open, tab]);

  // 组件整体卸载（页面卸载 / HMR）：slot 可能已 detached，面板仍要还回文档内的隐藏容器
  useLayoutEffect(() => () => stashLegacyPanes(slotRef.current, document.getElementById('legacyPanes')), []);

  const close = () => setOpen(false);
  const onMaskClick = (ev) => { if (ev.target === ev.currentTarget) close(); };

  const tabs = TABS.filter(([name]) => !(ADMIN_TABS.indexOf(name) >= 0 && !admin));

  return (
    <div className="modal-mask" hidden={!open} onClick={onMaskClick}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
        <div className="modal-head">
          <div>
            <h2 id="settingsTitle">设置</h2>
            <p className="modal-sub" id="settingsSummary">{summary || '加载中…'}</p>
          </div>
          <button className="modal-close" id="settingsClose" type="button" aria-label="关闭" onClick={close}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
          </button>
        </div>

        <div className="tabs" id="tabs">
          {tabs.map(([name, label]) => (
            <button
              key={name}
              type="button"
              className={'tab' + (tab === name ? ' active' : '')}
              data-tab={name}
              aria-pressed={tab === name ? 'true' : 'false'}
              onClick={() => setTab(name)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {tab === 'appearance' && open && <AppearancePane />}
          {tab === 'model' && open && <ModelPane />}
          {tab === 'about' && open && <AboutPane />}
          <div
            className="tab-pane-legacy"
            ref={slotRef}
            hidden={!open || LEGACY_TABS.indexOf(tab) < 0}
          />
        </div>
      </div>
    </div>
  );
}

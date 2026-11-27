import React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsDialog } from '../src/components/settings/SettingsDialog';
import { useSettingsStore } from '../src/stores/settings-store';
import { until } from './pdf-lifecycle.browser.mjs';
import i18n from '../src/i18n';
import '../src/styles/globals.css';

let fixture;

export async function openSettingsFixture() {
  await i18n.changeLanguage('en');
  const previousButton = document.createElement('button');
  previousButton.textContent = 'Previous focus';
  document.body.append(previousButton);
  previousButton.focus();
  const mount = document.createElement('div');
  document.body.append(mount);
  const previousTauri = window.__TAURI_INTERNALS__;
  fixture = { previousButton, mount, previousTauri, root: createRoot(mount), closed: false, failWrites: true, writes: 0, disk: null };
  window.__TAURI_INTERNALS__ = {
    ...previousTauri,
    async invoke(command, args) {
      if (command === 'detect_cloud_sync') return { status: 'Unavailable', icloud_path: null, platform: 'windows' };
      if (command === 'get_md_association_status') return false;
      if (command === 'save_config') {
        fixture.writes++;
        if (fixture.failWrites) throw new Error('fixture disk full');
        fixture.disk = args.config;
        return;
      }
      throw new Error(`Unexpected native command: ${command}`);
    },
  };
  useSettingsStore.setState((state) => ({
    config: { ...state.config, theme: 'system', language: 'en' },
    saveStatus: 'idle', saveError: null,
  }));
  fixture.root.render(React.createElement(SettingsDialog, { onClose() {
    fixture.closed = true;
    fixture.root.unmount();
  } }));
  await until(() => mount.querySelector('select'), 'Settings dialog did not render');
  await Promise.all(mount.getAnimations({ subtree: true }).map((animation) => animation.finished));
  return { opened: true };
}

export function focusThemeControl() {
  const select = [...fixture.mount.querySelectorAll('select')].find((element) => [...element.options].some((option) => option.value === 'dark'));
  select.focus();
  return { value: select.value };
}

export async function allowRetryAndGetPoint() {
  await until(() => fixture.mount.textContent.includes('fixture disk full'), 'Settings write failure was not visible in the dialog');
  const retry = [...fixture.mount.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Retry');
  if (!retry) throw new Error('Settings failure provided no retry action');
  fixture.failWrites = false;
  const rect = retry.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export async function verifySettingsRetry() {
  await until(() => useSettingsStore.getState().saveStatus === 'idle', 'Retry did not finish saving settings');
  if (fixture.disk?.theme !== 'dark' || fixture.writes !== 2) throw new Error('Retry did not persist the selected theme exactly once');
  if (fixture.mount.textContent.includes('fixture disk full')) throw new Error('Settings failure did not clear after retry');
  return { passed: true, failureVisible: true, retryPersisted: true };
}

export async function verifySettingsClosed() {
  try {
    await until(() => fixture.closed, 'Escape did not close the settings dialog');
  } catch (error) {
    throw new Error(`${error.message}; focused=${document.activeElement?.tagName}`);
  }
  if (document.activeElement !== fixture.previousButton) throw new Error('Dialog did not restore focus to the opener');
  return { passed: true, escapeClosed: true, focusRestored: true };
}

export function editorTabPoint() {
  const button = [...fixture.mount.querySelectorAll('button')].find((element) => element.textContent.trim() === i18n.t('settings.editor'));
  const rect = button.getBoundingClientRect();
  fixture.failWrites = false;
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export async function focusFontSize() {
  const findInput = () => [...fixture.mount.querySelectorAll('input')].find((element) => element.getAttribute('aria-label') === `${i18n.t('settings.fontSize')}:`);
  await until(findInput, 'Editor font-size field has no accessible label');
  const input = findInput();
  input.focus();
  input.select();
}

export function verifyFontDraft() {
  const value = fixture.mount.querySelector('input[type="number"]').value;
  if (value !== '24' || useSettingsStore.getState().config.editor_font_size !== 15 || fixture.writes !== 0) {
    throw new Error(`Numeric settings did not preserve an uncommitted draft: ${value}, writes=${fixture.writes}`);
  }
  return { passed: true, draftPreserved: true };
}

export async function verifyFontCommit() {
  try {
    await until(() => fixture.disk?.editor_font_size === 24, 'Enter did not persist the font size');
  } catch (error) {
    throw new Error(`${error.message}; writes=${fixture.writes}; diskFont=${fixture.disk?.editor_font_size}; previewFont=${fixture.disk?.preview_font_size}; focus=${document.activeElement?.tagName}; invalid=${fixture.mount.querySelector('input[type="number"]')?.getAttribute('aria-invalid')}`);
  }
  if (fixture.writes !== 1) throw new Error('One field commit triggered duplicate settings writes');
  return { passed: true, fontSizeSaved: 24, writes: fixture.writes };
}

export async function focusFontFamily() {
  const findInput = () => [...fixture.mount.querySelectorAll('input')].find((element) => element.getAttribute('aria-label') === `${i18n.t('settings.fontFamily')}:`);
  await until(findInput, 'Editor font-family field did not appear');
  findInput().focus();
  findInput().select();
}

export function verifyCompositionNotSubmitted() {
  if (fixture.writes !== 0) throw new Error('IME candidate confirmation submitted the settings field');
  return { passed: true, compositionDidNotSubmit: true };
}

export function verifyCompositionDidNotClose() {
  if (fixture.closed) throw new Error('IME cancellation closed the settings dialog');
  return { passed: true, compositionDidNotClose: true };
}

export function cleanupSettingsFixture() {
  if (!fixture) return;
  if (!fixture.closed) fixture.root.unmount();
  fixture.mount.remove();
  fixture.previousButton.remove();
  if (fixture.previousTauri === undefined) delete window.__TAURI_INTERNALS__;
  else window.__TAURI_INTERNALS__ = fixture.previousTauri;
  fixture = null;
}

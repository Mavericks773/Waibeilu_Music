import type { RoomTab } from './state.js';
export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element ${id}`);
  return el as T;
}
export class AppShell {
  private timer?: number;
  room(): void {
    element('login-screen').hidden = true;
    element('room-screen').hidden = false;
  }
  login(): void {
    element('login-screen').hidden = false;
    element('room-screen').hidden = true;
  }
  tab(tab: RoomTab): void {
    document.body.dataset.tab = tab;
    element('tab-playlist').setAttribute('aria-pressed', String(tab === 'playlist'));
    element('tab-player').setAttribute('aria-pressed', String(tab === 'player'));
  }
  notice(text: string, action = ''): void {
    element('notice').hidden = !text;
    element('notice-text').textContent = text;
    element('notice-action').hidden = !action;
    element('notice-action').textContent = action;
  }
  toast(message: string): void {
    element('toast').textContent = message;
    element('toast').hidden = false;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => (element('toast').hidden = true), 6000);
  }
}

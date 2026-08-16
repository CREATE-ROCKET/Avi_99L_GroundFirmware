const DEPRECATED_ACTIONS = new Set(['paraFree', 'paraHold', 'paraMoveRelative', 'setParaOpen', 'setParaClose']);

function commandBit(bit) {
  const item = window.__groundStoreForParachuteUi?.getLatestValue?.(`Command status.bit${bit}`);
  return typeof item?.value === 'boolean' ? item.value : null;
}

function simplifyParachuteUi(root = document) {
  for (const action of DEPRECATED_ACTIONS) {
    root.querySelectorAll?.(`[data-action="${action}"]`).forEach((element) => element.remove());
  }
  root.querySelectorAll?.('[data-move-para], [data-set-para-absolute], #para-relative, #para-open-absolute, #para-close-absolute')
    .forEach((element) => element.remove());

  root.querySelectorAll?.('.panel').forEach((panel) => {
    if (!panel.textContent?.includes('PARACHUTE SERVO')) return;
    panel.querySelectorAll('.action-row').forEach((row) => {
      if (!row.querySelector('[data-action="paraOpen"], [data-action="paraClose"]')) row.remove();
    });
    panel.querySelectorAll('.metric-card').forEach((card) => {
      const label = card.querySelector('span')?.textContent?.trim();
      if (label === 'OPEN' || label === 'CLOSE') card.remove();
      if (label === 'CURRENT ABS') card.querySelector('span').textContent = 'CURRENT';
    });
    const graphic = panel.querySelector('.para-graphic');
    if (graphic) {
      const title = graphic.querySelector('span');
      const note = graphic.querySelector('small');
      if (title) title.textContent = 'STS3215 / PARACHUTE';
      if (note) note.textContent = 'OPEN / CLOSE ONLY';
    }
    const summary = panel.querySelector('.small-summary');
    if (summary) summary.textContent = 'OPEN / CLOSE only. Absolute endpoint setting, persistence, FREE, HOLD, and manual relative movement are disabled.';
  });

  const readiness = root.querySelector?.('.readiness-panel');
  if (readiness) {
    readiness.querySelectorAll('.status-row').forEach((row) => {
      const label = row.querySelector('span')?.textContent?.trim();
      if (label === 'PARA OPEN' || label === 'PARA CLOSE') row.remove();
    });
    const values = [5, 21, 16, 17, 18].map(commandBit);
    if (values.every((value) => value !== null)) {
      const ready = values.every(Boolean);
      const state = readiness.querySelector('.big-state');
      if (state) {
        state.textContent = ready ? 'FLIGHT READY' : 'NOT READY';
        state.classList.toggle('ok', ready);
        state.classList.toggle('error', !ready);
      }
    }
  }
}

export function installParachuteSimpleUi(store) {
  window.__groundStoreForParachuteUi = store;
  const observer = new MutationObserver(() => simplifyParachuteUi());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  simplifyParachuteUi();
}

const DEPRECATED_ACTIONS = new Set(['paraFree', 'paraHold', 'paraMoveRelative', 'setParaOpen', 'setParaClose']);

function removeDeprecatedControls(root = document) {
  for (const action of DEPRECATED_ACTIONS) {
    root.querySelectorAll?.(`[data-action="${action}"]`).forEach((element) => element.remove());
  }
  root.querySelectorAll?.('[data-move-para], [data-set-para-absolute], #para-relative, #para-open-absolute, #para-close-absolute')
    .forEach((element) => element.remove());

  root.querySelectorAll?.('.panel').forEach((panel) => {
    if (!panel.textContent?.includes('PARACHUTE SERVO')) return;
    panel.querySelectorAll('.action-row').forEach((row) => {
      if (!row.querySelector('[data-action="paraOpen"], [data-action="paraClose"]')) {
        row.remove();
      }
    });
    panel.querySelectorAll('.metric-card').forEach((card) => {
      const label = card.querySelector('span')?.textContent?.trim();
      if (label === 'OPEN' || label === 'CLOSE') card.remove();
      if (label === 'CURRENT ABS') card.querySelector('span').textContent = 'CURRENT';
    });
    const summary = panel.querySelector('.small-summary');
    if (summary) summary.textContent = 'OPEN / CLOSE are fixed relative movements. Endpoint persistence and absolute endpoint setting are not used.';
    const graphic = panel.querySelector('.para-graphic');
    if (graphic) {
      const title = graphic.querySelector('span');
      const note = graphic.querySelector('small');
      if (title) title.textContent = 'STS3215 / RELATIVE OPEN-CLOSE';
      if (note) note.textContent = 'OPEN / CLOSE ONLY';
    }
  });

  root.querySelectorAll?.('.readiness-panel .status-row').forEach((row) => {
    const label = row.querySelector('span')?.textContent?.trim();
    if (label === 'PARA OPEN' || label === 'PARA CLOSE') row.remove();
  });
}

const observer = new MutationObserver(() => removeDeprecatedControls());
observer.observe(document.documentElement, { childList: true, subtree: true });
removeDeprecatedControls();

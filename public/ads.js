// Advertisement slots (Google AdSense).
//
// Configured on the server with ADSENSE_CLIENT (ca-pub-…) and, for fixed ad
// units, ADSENSE_SLOT_TOP / ADSENSE_SLOT_BOTTOM. With only ADSENSE_CLIENT set,
// AdSense "Auto ads" decides where ads go. ADS_PLACEHOLDER=true shows empty,
// labelled boxes so you can see the layout before AdSense is set up.

import { h, $ } from './dom.js';

const SLOT_NAMES = ['top', 'bottom'];

export function setupAds(ads) {
  if (!ads) return;

  if (ads.enabled) {
    // Every script on the page needs the server's nonce (Google's strict CSP).
    const nonce = document.querySelector('script[nonce]')?.nonce || '';
    const script = h('script', {
      async: true,
      src: `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ads.client)}`,
      crossorigin: 'anonymous',
    });
    if (nonce) script.nonce = nonce;
    document.head.append(script);

    for (const name of SLOT_NAMES) {
      const slotId = ads.slots?.[name];
      if (!slotId) continue;
      const ins = h('ins', {
        class: 'adsbygoogle',
        'data-ad-client': ads.client,
        'data-ad-slot': slotId,
        'data-ad-format': 'auto',
        'data-full-width-responsive': 'true',
      });
      showSlot(name, ins);
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    }
    return;
  }

  if (ads.placeholder) {
    for (const name of SLOT_NAMES) {
      showSlot(name, h('div', { class: 'ad-placeholder', text: 'Ad space · set ADSENSE_CLIENT to show Google ads here' }));
    }
  }
}

function showSlot(name, content) {
  const slot = $(`#ad-${name}`);
  if (!slot) return;
  slot.replaceChildren(h('span', { class: 'ad-label', text: 'Advertisement' }), content);
  slot.hidden = false;
}

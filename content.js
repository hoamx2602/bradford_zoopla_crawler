(function () {
  const BASE = 'https://www.zoopla.co.uk';

  function getLocationFromSearchUrl(url) {
    const m = url.match(/\/for-sale\/property\/([^/?]+)/);
    return m ? m[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null;
  }

  function getSearchBaseUrlAndPage() {
    const url = window.location.href;
    if (!/\/for-sale\/property\/[^/]+\/?/.test(url)) return null;
    try {
      const u = new URL(url);
      const pn = u.searchParams.get('pn');
      const currentPage = pn ? parseInt(pn, 10) : 1;
      u.searchParams.delete('pn');
      const baseUrl = u.toString().replace(/\?$/, '');
      return { baseUrl: baseUrl.replace(/\?$/, ''), currentPage: isNaN(currentPage) ? 1 : currentPage };
    } catch (e) {
      return null;
    }
  }

  function getListingUrls() {
    const seen = new Set();
    const urls = [];
    document.querySelectorAll('a[href*="/for-sale/details/"]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const match = href.match(/\/for-sale\/details\/(?:contact\/)?(\d+)/);
      if (match && !seen.has(match[1])) {
        seen.add(match[1]);
        urls.push(BASE + '/for-sale/details/' + match[1] + '/');
      }
    });
    return urls;
  }

  function cleanNumber(val) {
    if (val == null || val === '') return 0;
    const s = String(val).replace(/,/g, '');
    const m = s.match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }

  function normAddr(obj) {
    if (typeof obj === 'string' && obj.trim()) return obj.trim();
    if (obj && typeof obj === 'object') {
      const parts = [
        obj.displayAddress || obj.streetAddress || obj.addressLine1,
        obj.locality || obj.addressLine2,
        obj.city || obj.town,
        obj.postalCode || obj.postcode
      ].filter(Boolean);
      return parts.join(', ');
    }
    return null;
  }

  function getListingFromNextData() {
    try {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el || !el.textContent) return null;
      const j = JSON.parse(el.textContent);
      const pp = (j.props || {}).pageProps || {};
      const paths = [
        () => pp.listingDetails,
        () => (pp.listingDetails && (pp.listingDetails.listing || pp.listingDetails.property)) || {},
        () => (pp.initialProps && pp.initialProps.listing) || {},
        () => pp.listing || {},
        () => pp.property || {}
      ];
      for (const path of paths) {
        const node = path();
        if (node && typeof node === 'object' && (node.displayAddress || node.description || node.detailedDescription || node.address)) {
          return node;
        }
      }
    } catch (e) {}
    return null;
  }

  function getDomAddressAndDescription() {
    let address = null;
    let description = null;
    const addressEl = document.querySelector('h1 address') || document.querySelector('address');
    if (addressEl) address = (addressEl.textContent || '').trim();
    if (!address) {
      const sel = document.querySelector('[data-testid="address-label"]') ||
        document.querySelector('[data-testid="listing-summary-address"]') ||
        document.querySelector('[data-testid="listing-detail-address"]');
      if (sel) address = (sel.textContent || '').trim();
    }
    if (!address) {
      const h1 = document.querySelector('h1');
      if (h1) {
        const t = (h1.textContent || '').trim();
        if (t.length < 200 && /\d/.test(t)) address = t;
      }
    }
    const postcodeRe = /[A-Z]{1,2}\d[A-Z0-9]?\s*\d[A-Z]{2}/;
    if (!address) {
      document.querySelectorAll('div, p, span').forEach((el) => {
        const txt = (el.textContent || '').trim();
        if (txt.length > 15 && txt.length < 150 && postcodeRe.test(txt) && txt.includes(',')) {
          address = address || txt;
        }
      });
    }
    const headings = document.querySelectorAll('h2, h3, h4, h5, span, p');
    for (let i = 0; i < headings.length; i++) {
      const t = (headings[i].textContent || '').trim().toLowerCase();
      if (t === 'about this property' || t.indexOf('about this property') === 0) {
        const section = headings[i].closest('section') || headings[i].closest('div[class]') || headings[i].parentElement;
        if (section) {
          description = (section.textContent || '').trim();
          if (description.length > 50) break;
        }
      }
    }
    if (!description) {
      const about = Array.from(document.querySelectorAll('*')).find((el) => {
        const text = (el.textContent || '').trim().toLowerCase();
        return el.children.length < 5 && text.indexOf('about this property') !== -1;
      });
      if (about) {
        const par = about.closest('section') || about.closest('div');
        if (par) description = (par.textContent || '').trim();
      }
    }
    return { address: address || null, description: description || null };
  }

  function inferPropertyType(titleAndDesc) {
    const s = (titleAndDesc || '').toLowerCase();
    if (/detached/.test(s) && !/semi/.test(s)) return 'Detached';
    if (/semi-detached|semi detached/.test(s)) return 'Semi-Detached';
    if (/terraced|terrace/.test(s)) return 'Terraced';
    if (/flat|apartment|duplex/.test(s)) return 'Flat/Apartment';
    if (/studio/.test(s)) return 'Studio';
    if (/bungalow/.test(s)) return 'Bungalow';
    return 'Other';
  }

  /** Click "Read full description" nếu có, đợi nội dung mở rộng rồi resolve. */
  function clickReadFullDescriptionAndWait() {
    return new Promise((resolve) => {
      const all = document.querySelectorAll('button, a, [role="button"]');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const text = (el.textContent || '').trim().toLowerCase();
        if (text.indexOf('read full description') !== -1) {
          try {
            el.click();
            setTimeout(resolve, 2000);
            return;
          } catch (e) {}
          break;
        }
      }
      resolve();
    });
  }

  function extractCurrentPage() {
    const url = window.location.href;
    const location = getLocationFromSearchUrl(document.referrer) || getLocationFromSearchUrl(url) || null;
    const dom = getDomAddressAndDescription();
    const listing = getListingFromNextData();

    const data = {
      url: url,
      city: location,
      price: null,
      address: dom.address || null,
      property_type: null,
      bedrooms: 0,
      bathrooms: 0,
      living_rooms: 0,
      area_sqft: 0,
      description: (dom.description || '').replace(/^\s*About this property\s*/i, '').replace(/\s+/g, ' ').trim() || null,
      epc_rating: null
    };

    if (listing) {
      if (!data.address) {
        data.address = normAddr(listing.displayAddress) || normAddr(listing.propertyDisplayAddress) ||
          normAddr(listing.address) || normAddr(listing.formattedAddress);
        if (!data.address && listing.address && typeof listing.address === 'object') {
          data.address = normAddr(listing.address);
        }
      }
      let desc = listing.detailedDescription || listing.description || listing.propertyDescription || listing.fullDescription || '';
      if (Array.isArray(desc)) desc = desc.join(' ');
      const features = listing.features || listing.bulletPoints || listing.keyFeatures || [];
      let featureText = features.map((f) => (typeof f === 'object' ? (f.content || f.description || f.text) : f) || '').join('. ');
      const fullDesc = (featureText + ' ' + desc).trim();
      if (fullDesc && !data.description) data.description = fullDesc;
      const epc = listing.epcRating || listing.currentEnergyRating || listing.energyEfficiencyRating || listing.epc;
      if (epc) {
        const s = String(epc).trim().toUpperCase();
        data.epc_rating = (s[0] && 'ABCDEFG'.includes(s[0])) ? s[0] : s;
      }
    }

    const bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
    const uiLower = bodyText.toLowerCase();

    if (!data.price) {
      const priceEls = document.body ? document.body.innerHTML.match(/£\s*[\d,]+/g) : [];
      let maxPrice = 0;
      (priceEls || []).forEach((s) => {
        const n = cleanNumber(s);
        if (n > 10000) maxPrice = Math.max(maxPrice, n);
      });
      if (maxPrice) data.price = maxPrice;
    }
    if (!data.price && document.body) {
      const m = document.body.innerHTML.match(/"price"\s*:\s*"?£?([\d,]+)"?/);
      if (m) data.price = cleanNumber(m[1]);
    }

    if (!data.epc_rating) {
      const em = uiLower.match(/epc\s*(?:rating)?\s*[:\-]?\s*([a-g])/);
      if (em) data.epc_rating = em[1].toUpperCase();
    }
    ['bedrooms', 'bathrooms', 'living_rooms', 'area_sqft'].forEach((key) => {
      const labels = {
        bedrooms: /(\d+)\s*(?:bed|beds|bedroom|bedrooms)/,
        bathrooms: /(\d+)\s*(?:bath|baths|bathroom|bathrooms)/,
        living_rooms: /(\d+)\s*(?:reception|receptions|living room|living rooms)/,
        area_sqft: /([\d,]+)\s*(?:sq\.\s*ft|sqft|sq\s*ft)/
      };
      const m = uiLower.match(labels[key]);
      if (m) data[key] = key === 'area_sqft' ? cleanNumber(m[1]) : parseInt(m[1], 10);
    });

    document.querySelectorAll('[aria-label]').forEach((el) => {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const num = cleanNumber(label);
      if (/\d+\s*bed/.test(label) && !data.bedrooms) data.bedrooms = num;
      if (/\d+\s*bath/.test(label) && !data.bathrooms) data.bathrooms = num;
      if (/\d+\s*(?:recept|living)/.test(label) && !data.living_rooms) data.living_rooms = num;
    });

    data.bedrooms = cleanNumber(data.bedrooms);
    data.bathrooms = cleanNumber(data.bathrooms);
    data.living_rooms = cleanNumber(data.living_rooms);
    data.area_sqft = cleanNumber(data.area_sqft);

    const title = (document.title || '').toLowerCase();
    const searchText = title + ' ' + (data.description || '').toLowerCase();
    data.property_type = inferPropertyType(searchText);
    if (data.property_type === 'Studio') data.bedrooms = 0;

    if (!data.address) {
      const og = document.querySelector('meta[property="og:title"]');
      if (og && og.getAttribute('content')) {
        data.address = og.getAttribute('content').split('|')[0].trim();
      }
    }
    if (!data.address && document.title) {
      data.address = document.title.replace(/\s*[–\-|]\s*Zoopla.*/i, '').trim();
    }

    return data;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_LISTING_LINKS') {
      sendResponse({ urls: getListingUrls() });
    } else if (msg.type === 'GET_SEARCH_BASE_URL') {
      sendResponse(getSearchBaseUrlAndPage());
    } else if (msg.type === 'EXTRACT_CURRENT_PAGE') {
      clickReadFullDescriptionAndWait()
        .then(function () {
          sendResponse({ data: extractCurrentPage() });
        })
        .catch(function () {
          sendResponse({ data: extractCurrentPage() });
        });
      return true;
    } else {
      sendResponse(null);
    }
    return true;
  });

  if (/\/for-sale\/details\/\d+/.test(window.location.pathname)) {
    setTimeout(function () {
      chrome.runtime.sendMessage({ type: 'PAGE_LOADED', url: window.location.href });
    }, 500);
  }
})();

/*
hi welcome to my tracking script
my old analytics service free trial expired. so i thought it would be fun to make my own!
if you're reading this, do send a message to the endpoint, use action = "message", put the message you want to send in data :D
don't try to spam pls, i have backend ratelimits. also this stuff bounces thru like 3 servers haha 
*/
(function() {
  const API_ENDPOINT = 'https://square-water-cc4b.fern89.workers.dev/';
  const PING_INTERVAL_MS = 9000;
  const CLICK_TRACKING_TIMEOUT = 100;
  
  async function sendAnalyticsDataFetch(action, dataPayload) {
    const payload = { action, data: dataPayload };
    try {
      const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });
    } catch (error) {}
  }

  function sendInitialPing() {
    sendAnalyticsDataFetch('ping', window.location.href);
  }

  function setupLinkTracking() {
    document.querySelectorAll('a').forEach(link => {
      try {
        if (!link.href || link.href.trim() === '') {
          return;
        }
        const linkUrl = new URL(link.href, window.location.href);
        const isExternalLink = linkUrl.hostname && linkUrl.hostname !== window.location.hostname;
        const isHttpProtocol = linkUrl.protocol === 'http:' || linkUrl.protocol === 'https:';

        if (isExternalLink && isHttpProtocol) {
          link.addEventListener('mousedown', function(event){
            const clickedHref = this.href;
            if (event.button != 0 && event.button != 1){
                return;
            }
            if (event.metaKey || event.ctrlKey || (event.buttons === 4 && event.button === 1)) {
               sendAnalyticsDataFetch('click', clickedHref);
               return;
            }

            event.preventDefault();
            let navigated = false;
            function navigate() {
              if (!navigated) {
                navigated = true;
                window.location.href = clickedHref;
              }
            }
            sendAnalyticsDataFetch('click', clickedHref)
              .finally(() => {
                navigate();
              });
            setTimeout(navigate, CLICK_TRACKING_TIMEOUT);
          });
        }
      } catch (e) {}
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    sendInitialPing();
    setInterval(sendInitialPing, PING_INTERVAL_MS);
    setupLinkTracking();
  });

})();
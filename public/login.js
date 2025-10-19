import { showUsage } from "./usage.js";

const $login = document.querySelector("#login");
const $result = document.querySelector("#result");
const $token = document.querySelector("#token");
const $usage = document.querySelector("#usage");

const redirect = new URLSearchParams(location.search).get("redirect");

// https://developers.google.com/identity/gsi/web/reference/js-reference
window.onload = function() {
  google.accounts.id.initialize({
    // https://console.cloud.google.com/auth/clients?project=s-anand-net
    client_id: "1098061226510-1gn6mjnpdi30jiehanff71ri0ejva0t7.apps.googleusercontent.com",
    use_fedcm_for_button: true,
    // ux_mode: "redirect",
    callback: async (response) => {
      const profile = await fetch(`/token?credential=${response.credential}`).then((r) => r.json());
      localStorage.setItem("aipipe", JSON.stringify(profile));
      await init();
    },
  });
  // Render the Google Sign-In button
  google.accounts.id.renderButton($login, {
    theme: "filled_blue",
    size: "large",
    shape: "pill",
    state: location.search,
  });
};

/**
 * Copy text from [data-copy] to clipboard when element is clicked
 *
 * @param {Element} $root The root element to search for [data-copy] clicks
 * @param {Function} content A function that returns {html, text} to copy from, given [data-copy] element.
 *                           Default: returns {html, text} from selector in [data-copy].
 */
export function copyAction($root, content) {
  content = content
    ?? ((el) => {
      const $el = $root.querySelector(el.dataset.copy);
      return $el.value ? { text: $el.value } : { html: $el.innerHTML, text: $el.textContent };
    });
  new bootstrap.Tooltip($root, { selector: "[data-copy]" });
  $root.addEventListener("click", async (e) => {
    const $copy = e.target.closest("[data-copy]");
    if (!$copy) return;
    const tooltip = bootstrap.Tooltip.getInstance($copy);
    const { html, text } = content($copy);
    const clipboard = { "text/plain": new Blob([text], { type: "text/plain" }) };
    if (html) clipboard["text/html"] = new Blob([html], { type: "text/html" });
    await navigator.clipboard.write([new ClipboardItem(clipboard)]);
    const originalTitle = $copy.getAttribute("data-bs-original-title");
    $copy.setAttribute("data-bs-original-title", "Copied");
    tooltip.show();
    setTimeout(() => {
      $copy.setAttribute("data-bs-original-title", originalTitle ?? "");
      tooltip.hide();
    }, 1000);
  });
}

async function init() {
  const { token, email } = JSON.parse(localStorage.getItem("aipipe") || "{}");
  if (!token) return;

  if (redirect) {
    const url = new URL(redirect, window.location.origin);
    // Restrict to same-origin redirects
    if (url.origin !== window.location.origin) return;
    url.searchParams.append("aipipe_token", token);
    url.searchParams.append("aipipe_email", email);
    window.location.href = url.toString();
    return;
  }

  $result.classList.remove("d-none");
  $token.value = token;
  await showUsage($usage, token, email);

  copyAction(document.body);
}

init();

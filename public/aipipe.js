function getProfile() {
  const profile = JSON.parse(localStorage.getItem("aipipe") || "{}");
  const params = new URLSearchParams(location.search);
  for (const [key, value] of params.entries())
    if (key.startsWith("aipipe_")) {
      profile[key.slice(7)] = value;
      params.delete(key, value);
    }

  localStorage.setItem("aipipe", JSON.stringify(profile));
  history.replaceState({}, "", location.pathname + (params.size ? "?" + params : "") + location.hash);

  return profile;
}

export { getProfile };

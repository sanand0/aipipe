function getProfile() {
  const profile = JSON.parse(localStorage.getItem("aipipe") || "{}");
  return profile;
}

export { getProfile };

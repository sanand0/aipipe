function getProfile() {
  let profile = JSON.parse(localStorage.getItem("aipipe") || "{}");
  let { token, email } = profile;

  while (!token || !email) {
    token = prompt("Please enter your AIPipe token:");
    if (!token) {
      alert("No token provided. Cannot continue.");
      throw new Error("No token provided");
    }

    const decoded = decodeJWT(token);
    email = decoded?.email;

    if (!email) {
      alert("Invalid token. Please enter a valid token.");
      token = null;
    }
  }

  localStorage.setItem("aipipe", JSON.stringify({ token, email }));

  return { token, email };
}

function decodeJWT(token) {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return decoded;
  } catch (err) {
    console.error("JWT decode failed:", err);
    return null;
  }
}

function getData() {
  return JSON.parse(localStorage.getItem("aipipe") || "{}");
}

export { getProfile, getData };

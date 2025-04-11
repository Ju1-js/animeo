const token = window.location.hash.match(/access_token=(.+?)&/)[1];
const domain = window.location.host;

const installButton = document.querySelector("#install-button");
const loginButton = document.querySelector("#login-button");
const successMessage = document.querySelector("#success-message");
const optionsContainer = document.querySelector("#options");
const helperText = document.querySelector("#helper");

function getInstallURL() {
  const enableSearch = optionsContainer.querySelector("#enable-search").checked;
  const preAddedOnly =
    optionsContainer.querySelector("#pre-added-only").checked;

  const configString = JSON.stringify({
    token,
    enableSearch,
    preAddedOnly,
  });
  const config = encodeURIComponent(configString);

  return `stremio://${domain}/${config}/manifest.json`;
}

optionsContainer.querySelectorAll("input").forEach((input) =>
  input.addEventListener("change", () => {
    helperText.querySelector("a").href = getInstallURL();
  })
);

installButton.addEventListener("click", () => {
  const url = getInstallURL();

  helperText.querySelector("a").href = url;
  window.open(url, "_blank").focus();
});

if (token) {
  installButton.classList.remove("disabled");
  loginButton.style.display = "none";
  successMessage.style.display = "initial";

  helperText.style.display = "initial";
  helperText.querySelector("a").href = getInstallURL();
}

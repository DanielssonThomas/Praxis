const routes = {
  manager: { label: "Manager", short: "m" },
  overview: { label: "Overview", short: "o" },
  kanban: { label: "Kanban", short: "k" },
  settings: { label: "Settings", short: "s" },
};
type Route = keyof typeof routes;

const form = document.querySelector<HTMLFormElement>("#command-form")!;
const input = document.querySelector<HTMLInputElement>("#command")!;
const feedback = document.querySelector<HTMLOutputElement>("#command-feedback")!;
const menu = document.querySelector<HTMLElement>("#main-nav")!;
const menuButton = document.querySelector<HTMLButtonElement>("#menu-toggle")!;
const settingsFrame = document.querySelector<HTMLIFrameElement>("#settings-frame")!;
const views = document.querySelectorAll<HTMLElement>("[data-view]");
const links = menu.querySelectorAll<HTMLAnchorElement>("[data-route]");
const drafts = new Map<Route, string>();
let current: Route | undefined;

function isRoute(value: string | undefined): value is Route {
  return value !== undefined && Object.hasOwn(routes, value);
}

function routeFromHash(): Route {
  const route = location.hash.slice(1);
  return isRoute(route) ? route : "manager";
}

function setMenu(open: boolean): void {
  menu.hidden = !open;
  menuButton.setAttribute("aria-expanded", String(open));
}

function display(route: Route): void {
  if (current !== route) {
    if (current !== undefined) drafts.set(current, input.value);
    input.value = drafts.get(route) ?? "";
    current = route;
  }

  for (const view of views) view.hidden = view.dataset.view !== route;
  for (const link of links) {
    if (link.dataset.route === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (route === "settings" && !settingsFrame.hasAttribute("src")) {
    settingsFrame.src = "/settings";
  }
  document.title = `${routes[route].label} — Praxis`;
  setMenu(false);
}

function navigate(route: Route): void {
  if (route !== current) history.pushState(null, "", `#${route}`);
  display(route);
}

function showFeedback(message: string): void {
  feedback.hidden = message === "";
  feedback.textContent = message;
}

const commands = new Map<string, Route>();
const helpEntries: string[] = [];
for (const route of Object.keys(routes) as Route[]) {
  const { short } = routes[route];
  commands.set(`/${route}`, route);
  commands.set(`/${short}`, route);
  helpEntries.push(`/${route} (/${short})`);
}
helpEntries.push("/help (/h)");

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const command = input.value.trim().toLowerCase();
  if (command === "") return;
  if (command === "/help" || command === "/h") {
    input.value = "";
    showFeedback(helpEntries.join(" · "));
    return;
  }

  const route = commands.get(command);
  if (route === undefined) {
    showFeedback("Unknown command. Try /help.");
    return;
  }
  input.value = "";
  showFeedback("");
  navigate(route);
});

menuButton.addEventListener("click", () => setMenu(menu.hidden));
for (const link of links) {
  link.addEventListener("click", (event) => {
    const route = link.dataset.route;
    if (!isRoute(route) || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(route);
    menuButton.focus();
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !menu.hidden) {
    setMenu(false);
    menuButton.focus();
  }
});
window.addEventListener("hashchange", () => display(routeFromHash()));
display(routeFromHash());

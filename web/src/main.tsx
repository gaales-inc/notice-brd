import { render } from "preact";
import "./styles.css";
import { resolveStart, usePath } from "./router";
import { getMode } from "./storage";
import { Toaster } from "./ui/common";
import { Dashboard } from "./ui/Dashboard";
import { Home } from "./ui/Home";
import { ScreenPage } from "./ui/Screen";

function App() {
  const path = usePath();
  let page;
  if (path === "/screen" || path.startsWith("/screen/")) page = <ScreenPage />;
  else if (path === "/dashboard" || path.startsWith("/dashboard/")) page = <Dashboard path={path} />;
  else page = <Home />;
  return (
    <>
      {page}
      <Toaster />
    </>
  );
}

resolveStart(getMode());
render(<App />, document.getElementById("app")!);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

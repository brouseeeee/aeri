(() => {
  const buttons = document.querySelectorAll("button");
  const panels = document.querySelectorAll(".composition-plane, .volume-bar");

  const setPos = (el, e) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };

  document.addEventListener("pointermove", (e) => {
    document.documentElement.style.setProperty("--pointer-x", `${e.clientX}px`);
    document.documentElement.style.setProperty("--pointer-y", `${e.clientY}px`);
    buttons.forEach((el) => setPos(el, e));
    panels.forEach((el) => setPos(el, e));
    document.body.classList.add("reveal-on");
  });

  document.documentElement.addEventListener("mouseleave", () => {
    document.body.classList.remove("reveal-on");
  });
})();
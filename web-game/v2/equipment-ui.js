export function nextWeapon(names, current, delta) {
  const index = Math.max(0, names.indexOf(current));
  return names[(index + (delta > 0 ? 1 : -1) + names.length) % names.length];
}

export function equipmentIcon(name) {
  let shape;
  if (name === "None") {
    shape = '<circle cx="16" cy="16" r="11"/><path d="m8 24 16-16"/>';
  } else if (name.startsWith("Shield_")) {
    shape = name.includes("Round") ? '<circle cx="16" cy="16" r="11"/><circle cx="16" cy="16" r="3"/>' :
      '<path d="M5 6q11-5 22 0v12q-3 8-11 12Q8 26 5 18Z"/>';
    if (name.endsWith("_2")) shape += '<path d="M16 5v23M5 14h22"/>';
    if (name.includes("Golden")) shape += '<path d="m16 9 5 7-5 7-5-7Z"/>';
  } else if (name === "Unarmed") {
    shape = '<path d="M8 18V9q2-3 4 0V6q2-3 4 0v1q2-3 4 0v2q2-3 4 0v10l-5 9h-8l-5-8q-2-5 2-5l4 4"/>';
  } else if (name.startsWith("Axe")) {
    shape = '<path d="M15 5v24M16 7q5 0 9-4l3 13q-6-4-12-2Z"/>';
    if (name === "Axe_Double") shape += '<path d="M14 7Q9 7 5 3L2 16q6-4 12-2Z"/>';
    if (name === "Axe_Small") shape += '<path d="M12 25h6"/>';
  } else if (name.startsWith("Hammer")) {
    shape = '<path d="M14 14v15h4V14M7 4h16v10H7Z"/>';
    if (name === "Hammer_Double") shape += '<path d="M3 3h4v12H3ZM23 3h6v12h-6Z"/>';
  } else if (name === "Spear") {
    shape = '<path d="m16 2-5 10 5 3 5-3ZM16 15v15"/>';
  } else if (name === "Scythe") {
    shape = '<path d="M12 5v25M5 5Q22-1 29 15 18 7 12 9"/>';
  } else if (name.startsWith("Dagger")) {
    shape = name === "Dagger_2" ? '<path d="M13 20Q25 12 21 3L12 12v8M8 21h15M16 21v8"/>' :
      '<path d="m16 5-4 7v9h8v-9ZM8 22h16M16 22v8"/>';
  } else {
    shape = '<path d="m16 2-4 6v14h8V8ZM7 23h18M16 23v7"/>';
    if (name === "Sword_2") shape += '<path d="m12 13 8 4"/>';
    if (name === "Sword_Big" || name === "Claymore") shape += '<path d="M9 10v10M23 10v10"/>';
    if (name === "Claymore") shape += '<path d="m7 23-2-4m20 4 2-4"/>';
  }
  const color = name.includes("Golden") ? "#f5cf68" : name.includes("Shield") ? "#a9ddff" : "#e5e9db";
  return `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" fill="#43534d" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${shape}</svg>`;
}

import { mark, ptyWrite } from "./api";
import { TerminalTab } from "./terminal-tab";

export type StressHost = {
  newTab(): Promise<TerminalTab>;
  closeTab(id: number): void;
  activate(id: number): void;
};

const MARKER = "__DONE__";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runAndWait(tab: TerminalTab, cmd: string, timeoutMs = 60000): Promise<boolean> {
  return new Promise((resolve) => {
    const decoder = new TextDecoder();
    let tail = "";
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      tab.onOutput = undefined;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    tab.onOutput = (bytes) => {
      tail += decoder.decode(bytes, { stream: true });
      if (tail.includes(MARKER)) finish(true);
      tail = tail.slice(-MARKER.length);
    };
    if (cmd) ptyWrite(tab.id, `${cmd}; echo __DO""NE__\r`);
  });
}

async function waitReady(tab: TerminalTab): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const probe = runAndWait(tab, "", 2000);
    ptyWrite(tab.id, `echo __DO""NE__\r`);
    if (await probe) return;
  }
  await mark(`ready_timeout_tab_${tab.id}`);
}

export async function stress(host: StressHost): Promise<void> {
  const line = "0123456789".repeat(12);
  await sleep(3000);
  await mark("start");
  const base: TerminalTab[] = [];
  for (let i = 0; i < 10; i++) {
    const tab = await host.newTab();
    await waitReady(tab);
    base.push(tab);
  }
  await sleep(10000);
  await mark("baseline_10_tabs");

  for (const tab of base) {
    host.activate(tab.id);
    await runAndWait(tab, `yes ${line} | head -n 200000`, 120000);
  }
  await sleep(10000);
  await mark("after_flood_24MB_x10");

  for (let round = 1; round <= 2; round++) {
    for (let i = 1; i <= 300; i++) {
      const tab = await host.newTab();
      await waitReady(tab);
      await runAndWait(tab, "seq 1 3000");
      host.closeTab(tab.id);
      if (i % 50 === 0) await mark(`churn_progress_${(round - 1) * 300 + i}`);
    }
    await sleep(10000);
    await mark(`after_churn_${round * 300}_tabs`);

    for (let i = 0; i < 2000; i++) {
      host.activate(base[i % base.length].id);
      await sleep(10);
    }
    await sleep(10000);
    await mark(`after_switch_${round * 2000}`);
  }

  await sleep(30000);
  await mark("settled");
  await mark("done");
}

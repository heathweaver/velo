import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Copy } from "lucide-react";
import { isWeb } from "@/services/transport";

const isMac = navigator.userAgent.includes("Macintosh");

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // The custom window titlebar is desktop-only. On the web there is no Tauri
    // window runtime, so calling getCurrentWindow() would throw
    // ("Cannot read properties of undefined (reading 'metadata')").
    if (isWeb()) return;

    const appWindow = getCurrentWindow();
    appWindow.isMaximized().then(setMaximized);

    // Listen for resize events to track maximize state
    let unlisten: (() => void) | undefined;
    appWindow.onResized(() => {
      appWindow.isMaximized().then(setMaximized);
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, []);

  // Browser provides its own window chrome — render nothing on the web.
  if (isWeb()) return null;

  // macOS: the window is configured with an overlay title bar and hidden title,
  // so the traffic lights already float over the content. Drawing a bar here
  // just to repeat the app name costs a strip of vertical space across the top
  // of the window. The sidebar reserves room for the lights and carries the
  // drag region instead. Windows and Linux still need this bar for the
  // minimise/maximise/close controls below.
  if (isMac) return null;

  const handleMinimize = () => getCurrentWindow().minimize();
  const handleMaximize = () => getCurrentWindow().toggleMaximize();
  const handleClose = () => getCurrentWindow().close();

  return (
    <div
      data-tauri-drag-region
      className="flex items-center justify-between h-9 bg-sidebar-bg border-b border-border-primary select-none shrink-0"
    >
      {/* App title — left side (extra padding on macOS for traffic light buttons) */}
      <div data-tauri-drag-region className={`flex items-center gap-2 ${isMac ? "pl-20" : "pl-4"}`}>
        <span data-tauri-drag-region className="text-xs font-semibold text-sidebar-text tracking-wide">
          Velo
        </span>
      </div>

      {/* Window controls — right side (hidden on macOS, uses native traffic lights) */}
      {!isMac && (
        <div className="flex items-center h-full">
          <button
            onClick={handleMinimize}
            className="h-full px-3.5 flex items-center justify-center text-sidebar-text/70 hover:bg-sidebar-hover transition-colors"
            title="Minimize"
          >
            <Minus size={14} />
          </button>
          <button
            onClick={handleMaximize}
            className="h-full px-3.5 flex items-center justify-center text-sidebar-text/70 hover:bg-sidebar-hover transition-colors"
            title={maximized ? "Restore" : "Maximize"}
          >
            {maximized ? <Copy size={12} /> : <Square size={12} />}
          </button>
          <button
            onClick={handleClose}
            className="h-full px-3.5 flex items-center justify-center text-sidebar-text/70 hover:bg-danger hover:text-white transition-colors"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

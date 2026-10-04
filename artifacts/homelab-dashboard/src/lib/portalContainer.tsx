import { createContext, useContext, type ComponentType } from "react";

// Where Radix portals mount. Undefined = document.body (Radix default). The
// expanded tile panel lives in the browser top layer, so anything portaled to
// body would render *underneath* it; while a panel is open it provides its own
// host element here so nested dialogs/menus/selects/tooltips stack above it.
export const PortalContainerContext = createContext<HTMLElement | null>(null);

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined;
}

// Wrap a Radix Portal so it defaults its container to the scoped host.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withPortalContainer<C extends ComponentType<any>>(Portal: C): C {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const P = Portal as ComponentType<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function ScopedPortal(props: any) {
    const container = usePortalContainer();
    return <P container={container} {...props} />;
  }
  return ScopedPortal as unknown as C;
}

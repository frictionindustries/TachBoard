import { httpClient, UnsafeUrlError } from "./http.js";

// These GameDig protocols use an internal HTTP client which follows redirects
// and resolves the original hostname again. Keep their existing player-count
// requests on our guarded transport instead of handing them to GameDig.
export async function queryHttpGamePlayers(type: string, host: string, port: number) {
  const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  const config = {
    ssrfPublicOnly: true,
    maxRedirects: 0,
    proxy: false as const,
    timeout: 4000,
  };
  if (type === "palworld") {
    // GameDig's Palworld protocol re-resolves options.host through Got. We
    // only need metrics; do not let the library issue any of its HTTP calls.
    const { data } = await httpClient.get(`http://${authority}/v1/api/metrics`, config);
    return { numplayers: data?.currentplayernum, maxplayers: data?.maxplayernum };
  }
  if (type === "eco") {
    // Preserve GameDig's +1 query-port preference and allocation-port fallback.
    const ports = port < 65535 ? [port + 1, port] : [port];
    for (const queryPort of ports) {
      try {
        const target = `${host.includes(":") ? `[${host}]` : host}:${queryPort}`;
        const { data } = await httpClient.get(`http://${target}/frontpage`, config);
        return { numplayers: data?.Info?.OnlinePlayers, maxplayers: data?.Info?.TotalPlayers };
      } catch (error) {
        if (error instanceof UnsafeUrlError || queryPort === port) throw error;
      }
    }
  }
  if (type === "factorio") {
    const { data } = await httpClient.get(
      `https://multiplayer.factorio.com/get-game-details/${authority}`, config,
    );
    return { numplayers: Array.isArray(data?.players) ? data.players.length : 0, maxplayers: data?.max_players };
  }
  if (type === "satisfactory") {
    const url = `https://${authority}/api/v1/`;
    const login = await httpClient.post(url, {
      function: "PasswordlessLogin", data: { MinimumPrivilegeLevel: "Client" },
    }, config);
    const token = login.data?.data?.authenticationToken;
    if (typeof token !== "string" || !token) throw new Error("Game server login failed.");
    const { data } = await httpClient.post(url, { function: "QueryServerState" }, {
      ...config, headers: { Authorization: `Bearer ${token}` },
    });
    const state = data?.data?.serverGameState;
    return { numplayers: state?.numConnectedPlayers, maxplayers: state?.playerLimit };
  }
  throw new Error("Unsupported HTTP game query.");
}
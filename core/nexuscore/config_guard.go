package nexuscore

import (
	"context"
	"time"

	"github.com/nexus/nexus-core/desktop/guard"
)

// ============================================================================================
// CONFIGGUARD FOR APPLE
//
// Android runs ConfigGuard.kt on every config before NewService: the battery bounds that live
// in config fields (health-check floor, TUN stack) and, above all, the proxy server's hostname
// resolved by the platform resolver, checked for poisoned answers and pinned in a hosts DNS
// server. Without that pinning the core resolves the server through dns-direct, DoH to an IP
// literal that the networks this client is for reset outright (singboxConfig.ts): every
// connect to a server given by name fails.
//
// Apple has no Kotlin, so it uses the Go port in desktop/guard - the same rules, pinned
// against the Kotlin numbers by guard_test.go. Its safety checks (loopback-only listeners, no
// privileged inbounds) pass every config Nexus generates. The path check stays off: the
// extension is not a privileged daemon taking configs over a socket.
//
// Called by the packet-tunnel extension before NewService and before Reload. The resolver is
// the system's: in the extension, before its tunnel's settings apply and also after (its own
// lookups bypass its tunnel), that is the physical network's DNS.
// ============================================================================================

// guardTimeout bounds the whole check, all server lookups included.
const guardTimeout = 20 * time.Second

// GuardConfig returns the config to run: config with the policy rewrites applied and its proxy
// servers' hostnames pre-resolved, or an error when it is refused. A refusal names the reason
// and may name a hostname; the caller redacts before logging.
func GuardConfig(config string) (string, error) {
	return guardConfig(context.Background(), config, nil)
}

func guardConfig(ctx context.Context, config string, resolver guard.Resolver) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, guardTimeout)
	defer cancel()
	result, err := guard.Enforce(ctx, config, guard.Options{Resolver: resolver})
	if err != nil {
		return "", err
	}
	return result.Config, nil
}

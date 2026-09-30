interface UserIdentitySource {
    core?: {screenName?: string; name?: string; createdAt?: string};
    legacy?: {screenName?: string; name?: string; createdAt?: string};
}

// The SDK decodes current identity fields into core; older responses used legacy.
export function getUserIdentity(user?: UserIdentitySource | null) {
    return {
        screenName: user?.core?.screenName || user?.legacy?.screenName || '',
        name: user?.core?.name || user?.legacy?.name || '',
        createdAt: user?.core?.createdAt || user?.legacy?.createdAt || ''
    };
}

package integrations

// Windows has no O_NOFOLLOW flag. The strict file helpers still inspect every
// path component with Lstat and use os.Root to keep access below the account
// directory.
const openNoFollow = 0

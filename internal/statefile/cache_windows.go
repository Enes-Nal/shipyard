package statefile

import "os"

// Size and modification time remain stable cache keys on Windows. Windows'
// FileIndex is not exposed through os.FileInfo's public API.
func statKey(_ os.FileInfo, _ *fileKey) {}

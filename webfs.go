// Package notediscovery embeds the web assets (frontend, themes, locales) so the
// binary can run standalone, while still allowing a `web/` directory next to the
// working directory to override what was compiled in (edit assets without rebuild).
package notediscovery

import (
	"embed"
	"io/fs"
	"os"
)

//go:embed all:web
var embeddedWeb embed.FS

// AssetFS returns the filesystem holding web/, themes/ and locales/.
// A web/ directory on disk wins over the embedded copy.
func AssetFS() fs.FS {
	if st, err := os.Stat("web"); err == nil && st.IsDir() {
		return os.DirFS("web")
	}
	sub, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		return embeddedWeb
	}
	return sub
}

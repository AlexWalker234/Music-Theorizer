// Music Theorizer desktop launcher.
//
// One double-clickable program: it carries the whole app inside it, serves it to a
// dedicated app window (Edge or Chrome in app mode, no address bar), and forwards the
// AI Coach's requests to an Ollama server. Because the requests go through this
// program instead of straight from the browser, Ollama does not need OLLAMA_ORIGINS,
// and the Ollama server can be this computer or another one on the network. Song analysis
// requests for the optional AI helper (ai-helper/server.py) are forwarded the same way.
package main

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

//go:embed web
var webFiles embed.FS

const (
	version       = "1.0"
	preferredPort = 47831 // fixed so saved settings (browser storage is per address) survive restarts
	defaultOllama = "http://127.0.0.1:11434"
	defaultHelper = "http://127.0.0.1:8765" // the optional AI analysis helper (ai-helper/server.py)
	idleExit      = 45 * time.Second
)

type config struct {
	Ollama string `json:"ollama"`
	Helper string `json:"helper"`
}

var (
	mu       sync.Mutex
	cfg      = config{Ollama: defaultOllama, Helper: defaultHelper}
	cfgPath  string
	lastSeen = time.Now()
)

func main() {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	dir = filepath.Join(dir, "MusicTheorizer")
	_ = os.MkdirAll(dir, 0o755)
	cfgPath = filepath.Join(dir, "config.json")
	logFile, err := os.OpenFile(filepath.Join(dir, "launcher.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err == nil {
		log.SetOutput(logFile)
	}
	loadConfig()
	if v := os.Getenv("MT_OLLAMA"); v != "" {
		cfg.Ollama = v
	}
	if v := os.Getenv("MT_HELPER"); v != "" {
		cfg.Helper = v
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", preferredPort))
	if err != nil {
		// Already running? Then just open another window onto it.
		if isOurs(preferredPort) {
			openWindow(fmt.Sprintf("http://127.0.0.1:%d/", preferredPort), dir)
			return
		}
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			log.Fatal(err)
		}
	}
	addr := fmt.Sprintf("http://%s/", ln.Addr().String())
	log.Printf("Music Theorizer %s at %s, Ollama at %s", version, addr, cfg.Ollama)

	go func() { log.Fatal(http.Serve(ln, routes())) }()

	done := make(chan struct{})
	go func() {
		openWindow(addr, dir) // returns when the app window closes, if we could tell
		close(done)
	}()
	<-done
	// The window closed, or it went to a browser we can't watch: keep serving until
	// the page stops checking in.
	waitIdle()
}

func waitIdle() {
	for {
		time.Sleep(5 * time.Second)
		mu.Lock()
		idle := time.Since(lastSeen)
		mu.Unlock()
		if idle > idleExit {
			return
		}
	}
}

func routes() http.Handler {
	web, _ := fs.Sub(webFiles, "web")
	files := http.FileServer(http.FS(web))
	mux := http.NewServeMux()

	// The page loads js/desktop.js; in the browser build it says "not desktop".
	mux.HandleFunc("/js/desktop.js", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		b, _ := json.Marshal(map[string]string{"ollama": cfg.Ollama, "helper": cfg.Helper, "version": version})
		mu.Unlock()
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprintf(w, "window.MT_DESKTOP = %s;\n", b)
	})

	mux.HandleFunc("/launcher/alive", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		lastSeen = time.Now()
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"app":"music-theorizer","version":%q}`, version)
	})

	mux.HandleFunc("/launcher/config", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			var in config
			if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in); err != nil {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			mu.Lock()
			cur := cfg
			mu.Unlock()
			if in.Ollama != "" {
				u, err := normalize(in.Ollama, defaultOllama, "11434")
				if err != nil {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				cur.Ollama = u
			}
			if in.Helper != "" {
				u, err := normalize(in.Helper, defaultHelper, "8765")
				if err != nil {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				cur.Helper = u
			}
			mu.Lock()
			cfg = cur
			mu.Unlock()
			saveConfig()
		}
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(cfg)
	})

	// /ollama/... is forwarded to the Ollama server and /aihelper/... to the AI analysis helper,
	// without the browser's Origin header.
	mux.HandleFunc("/ollama/", relay("/ollama", "Ollama", func() string { return cfg.Ollama }))
	mux.HandleFunc("/aihelper/", relay("/aihelper", "the AI helper", func() string { return cfg.Helper }))

	mux.Handle("/", files)
	return localOnly(mux)
}

func relay(prefix, name string, addr func() string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		target, err := url.Parse(addr())
		mu.Unlock()
		if err != nil {
			http.Error(w, "bad address for "+name, http.StatusBadGateway)
			return
		}
		proxy := &httputil.ReverseProxy{
			Rewrite: func(pr *httputil.ProxyRequest) {
				pr.SetURL(target)
				pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, prefix)
				pr.Out.URL.RawPath = ""
				pr.Out.Host = target.Host
				pr.Out.Header.Del("Origin")
				pr.Out.Header.Del("Referer")
			},
			FlushInterval: -1, // stream answers word by word
			ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
				log.Printf("%s: %v", prefix, err)
				w.Header().Set("X-MT-Unreachable", "1")
				http.Error(w, "Could not reach "+name+" at "+target.String(), http.StatusBadGateway)
			},
		}
		proxy.ServeHTTP(w, r)
	}
}

// Only pages served by this program may use it.
func localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.Host)
		if host != "127.0.0.1" && host != "localhost" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && !strings.HasPrefix(o, "http://127.0.0.1:") && !strings.HasPrefix(o, "http://localhost:") {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func normalize(s, def, port string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return def, nil
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("use an address like http://192.168.1.20:" + port)
	}
	if u.Port() == "" && u.Scheme == "http" {
		u.Host += ":" + port
	}
	u.Path = strings.TrimRight(u.Path, "/")
	return u.String(), nil
}

func loadConfig() {
	b, err := os.ReadFile(cfgPath)
	if err != nil {
		return
	}
	var c config
	if json.Unmarshal(b, &c) == nil {
		if u, err := normalize(c.Ollama, defaultOllama, "11434"); err == nil {
			cfg.Ollama = u
		}
		if u, err := normalize(c.Helper, defaultHelper, "8765"); err == nil {
			cfg.Helper = u
		}
	}
}

func saveConfig() {
	mu.Lock()
	b, _ := json.MarshalIndent(cfg, "", "  ")
	mu.Unlock()
	if err := os.WriteFile(cfgPath, b, 0o644); err != nil {
		log.Printf("save config: %v", err)
	}
}

func isOurs(port int) bool {
	c := http.Client{Timeout: time.Second}
	res, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/launcher/alive", port))
	if err != nil {
		return false
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 512))
	return strings.Contains(string(b), "music-theorizer")
}

// openWindow shows the app in an app-mode window with its own browser profile, so the
// window is a separate process we can wait on. Falls back to the default browser.
func openWindow(addr, dir string) {
	profile := filepath.Join(dir, "window")
	args := []string{"--app=" + addr, "--user-data-dir=" + profile, "--window-size=1400,950", "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required"}
	for _, b := range browsers() {
		if _, err := os.Stat(b); err != nil {
			if _, err := exec.LookPath(b); err != nil {
				continue
			}
		}
		cmd := exec.Command(b, args...)
		if err := cmd.Start(); err == nil {
			log.Printf("window: %s", b)
			cmd.Wait()
			return
		}
	}
	log.Printf("no Edge or Chrome found; using the default browser")
	switch runtime.GOOS {
	case "windows":
		exec.Command("rundll32", "url.dll,FileProtocolHandler", addr).Start()
	case "darwin":
		exec.Command("open", addr).Start()
	default:
		exec.Command("xdg-open", addr).Start()
	}
}

func browsers() []string {
	switch runtime.GOOS {
	case "windows":
		var out []string
		for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LocalAppData"} {
			base := os.Getenv(env)
			if base == "" {
				continue
			}
			out = append(out,
				filepath.Join(base, `Microsoft\Edge\Application\msedge.exe`),
				filepath.Join(base, `Google\Chrome\Application\chrome.exe`),
				filepath.Join(base, `BraveSoftware\Brave-Browser\Application\brave.exe`))
		}
		return out
	case "darwin":
		return []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		}
	default:
		return []string{"google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"}
	}
}

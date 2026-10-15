# Homebrew formula template for tabcap. Not published: there is no tap yet.
# Before use, set `version` and copy the sha256 of
# tabcap-v<version>-darwin-arm64.tar.gz from the release's SHA256SUMS.
# Only macOS arm64 is built; add an `on_intel` block when a darwin-x64 build exists.
class Tabcap < Formula
  desc "Browser for AI agents: background tabs, accessibility-tree refs, recorded traffic"
  homepage "https://github.com/1A7432/tabcap"
  version "0.2.0"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/1A7432/tabcap/releases/download/v#{version}/tabcap-v#{version}-darwin-arm64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  def install
    bin.install "tabcap"
    (pkgshare/"skills").install "skills/tabcap"
    doc.install "README.md", "README.zh-CN.md"
  end

  def caveats
    <<~EOS
      Run `tabcap setup` once to download Chrome for Testing.
      The agent skill is in #{opt_pkgshare}/skills/tabcap.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tabcap --version")
  end
end

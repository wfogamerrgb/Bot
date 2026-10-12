'use strict'

// ── Themed word pools for generated Minecraft usernames ─────────────────────
// The generated names should read like a real player's handle, not like a bot
// roster: tech / hacking / sci-fi flavour, leetspeak, underscores and the odd
// typo. Minecraft usernames only allow letters, digits and underscore (3–16
// characters), so every word here is plain [a-z0-9]; the generator in
// generated-bots.js adds capitalisation, leet substitutions and separators.
//
// Words are stored space-separated to keep this file readable while still
// carrying a very large vocabulary. Everything is lowercased, deduplicated and
// validated on load, so a stray typo in this list can never break generation.

const SOURCES = {}

// Networking, protocols, the internet, distributed systems.
SOURCES.NET = `
packet socket socks proxy tunnel tunneling relay router routing gateway bridge
switch hub nic ethernet wifi fiber optic cable modem antenna satellite dish
beacon signal noise static latency jitter bandwidth throughput stream flow
traffic packetloss handshake hello ack nack syn fin reset icmp tcp udp quic
http https websocket grpc rest soap xml json yaml protobuf msgpack bson avro
dns doh doh3 dot resolver lookup zone record ttl cache cdn edge origin pop
peering bgp ospf mpls aspath prefix subnet supernet cidr vlan vrf vxlan
gre ipip wireguard openvpn ipsec ikev2 esp ah tls mtls ssl dtls cert x509
pkcs pem der csr ocsp crl acme ca pki chain trust pinning stapling
dhcp nat pat portmap forward dnat snat masquerade firewall iptables nftables
netfilter ebtables conntrack stateful packetfilter acl whitelist blacklist
blocklist allowlist rate limit throttle bucket token bucketfill leaky
loadbalancer haproxy nginx envoy traefik sidecar mesh istio linkerd consul
etcd zookeeper gossip swim serf memberlist cluster sharding partition
replication quorum raft paxos zab leader follower epoch term ballot
heartbeat ping pong keepalive timeout retry backoff jitter reconnect
websocket wss socketio mqtt amqp stomp nats kafka pulsar rabbitmq activemq
broker topic queue pubsub subscribe publish consumer producer partition
offset commit ack nak exactlyonce atleasteastonce besteffort delivery
cdn waf ddos scrub mitigation volumetric amplification reflection spoofing
bgpflow netflow sflow ipfix pcap tcpdump wireshark tshark sniff capture
packetforge scapy nmap masscan zmap rustscan unicornscan hping3
arp arpwatch gratuitous macflooding vlantag trunk access native untagged
spanningtree rstp mstp lldp cdp lacp bonding teaming failover ha
anycast unicast multicast broadcast loopback localhost wildcard
ipv4 ipv6 dualstack 4in6 6in4 sit teredo nat64 dns64 prefix96
autonomous system peering ixp colo datacenter rack blade chassis
pop region zone shard ring consistenthash rendezvous gossip
tincan proxywar socks4 socks5 httpconnect transport bridgehead
`

// Operating systems, kernels, low-level plumbing.
SOURCES.SYS = `
kernel syscall syscal table trap interrupt vector irq apic ioapic acpi smbios
uefi bios grub lilo bootloader bootload initramfs initrd dracut mkinitcpio
systemd init openrc runit s6 supervision daemon service unit socket activation
inode dentry superblock journal ext2 ext3 ext4 xfs btrfs zfs f2fs nilfs
reiser vfs mount umount fstab uuid label partition gpt mbr efi biosboot
lvm volume group physical logical thinpool snapshot reflink copyonwrite
mdadm raid raid0 raid1 raid5 raid6 raid10 mirror stripe parity rebuild
swap swappiness page pagetable pte tlb mmu vmsa paging segfault segv
sigsegv sigkill sighup sigterm sigint sigquit sigabrt sigpipe sigchld
signal handler sigaction sigaltstack signalfd epoll kqueue select poll
io_uring aio overlapped vectored scatter gather zerocopy splice tee
sendfile mmap munmap mprotect mlock brk sbrk heap arena jemalloc tcmalloc
malloc calloc realloc free fragment coalesce compact reclaim
thread process task sched scheduler cfs rt fifo rr nice priority affinity
numa node socket core hyperthread smt cache coherency mesi directory
mutex spinlock rwlock semaphore condvar barrier latch atomic cas cmpxchg
lockfree hazard pointer rcu seqlock percpu bigkernel bkl preempt
namespace pidnet mntns userns cgroupns utsns ipcns overlay unionfs
chroot pivot_root jail container lxc docker podman containerd cri
seccomp bpf ebpf xdp tc kprobe uprobe tracepoint ftrace perf
strace ltrace gdb lldb valgrind asan tsan msan ubsan kasan
proc sysfs devfs tmpfs ramfs hugetlb shm ipc semaphore msgqueue
tty pts pty console serial uart getty login shell bash zsh fish
cron crontab anacron systemdtimer inotify fanotify watch notify
udev devtmpfs hotplug sysfsattr firmware blob microcode
posix errno errnoval libc musl glibc dietlibc uclibc ldso ldpreload
elf pe coff macho dwarf eh_frame unwind backtrace symbol table
coredump corepattern apport systemdcoredump crash panic oops hung
watchdog softlockup hardlockup rcu_stall oom oomkiller overcommit
sysctl procfs kernelparam cmdline grubby modprobe insmod rmmod lsmod
module symbol version vermagic taint outoftree dkms
filesystem fsck badblocks smartctl hdparm nvme trim discard fstrim
quota xattr acl capability setuid setgid sticky umask chmod chown
selinux apparmor seccomp landlock tomoyo smack yama
`

// Programming languages, compilers, computer science.
SOURCES.CODE = `
compiler interpreter linker loader relocation symbol dynlib dylib so dll
bytecode jit aot ir ast cfg ssa phi dominance liveness register spill
optimization inline unroll vectorize unbox specialize devirtualize
macro preprocessor template generic monomorph trait interface impl
lambda closure capture functor monad applicative functorlaw currying
partial compose pipeline curry transducer reducer fold scan zip
promise future deferred async await coroutine fiber greenlet goroutine
channel select mutex semaphore waitgroup barrier countdown
callback event emitter listener observer subscribe signal slot
parser lexer tokenizer grammar bnf ebnf regex pcre dfa nfa backreference
compilerpass lowering desugar sugar syntactic semantic typecheck
type inference unification hindley milner polymorphism generics
monomorphization erasure boxing unboxing boxingheap escape
garbage collector gc mark sweep generational tri color incremental
concurrent compacting nursery tenured promotion finalizer weakref
arena bump allocator pool slab buddy pagemap freelists
stack frame pointer return address alignment redzone canary
heap overflow underflow useafterfree doublefree dangling wild
buffer overflow format string race condition deadlock livelock
starvation priority inversion convoy effect thundering herd
test unittest integration fuzzing property based golden snapshot
assert expect should chai mocha jest vitest jasmine tap ava
coverage branch line mutation testing pytest unittest2 tox
benchmark profile flamegraph hotspot sampling tracing spans
continuous integration pipeline deploy rollback canary bluegreen
feature flag toggle experiment gradual rollout killswitch
versioning semver changelog release tag branch merge rebase
git commit blob tree object packfile reflog gc prune
monorepo workspace lerna turbo bazel buck pants make cmake ninja
package registry npm pypi crates maven go proxy vendoring lockfile
dockerfile compose kubernetes helm chart operator controller
runtime virtual machine wasm wasi asm bytecode verifier sandbox
opcode mnemonic operand addressing immediate register indirect
algebra datatype union enum option result maybe either void
null nil none undefined sentinel poison tombstone stub mock
interface contract invariant precondition postcondition
algorithm heuristic complexity amortized bigo logarithmic
recursion tail iterative divide conquer dynamic memoization
graph tree bst avl redbtree btree trie radix suffix skiplist
hashmap hashtable hashtable2 hashmapopen robin hood swiss
quicksort mergesort heapsort radixsort timsort introsort
binarysearch interpolation fibonacci knapsack traveling
dynamicprogramming greedy backtracking branch bound
queue stack deque priorityqueue heap fibonacci pairing
linkedlist doubly skip circular ringbuffer circularbuffer
matrix vector tensor scalar quaternion complex modular
prime sieve factor gcd lcm modular exponentiation
entropy compression huffman lz77 lzw deflate brotli zstd
checksum crc32 crc64 sha1 sha256 sha512 blake keccak md5
serialization marshal encode decode base64 base32 hex
endian byteorder padding alignment packing serialization
abi calling convention cdecl stdcall fastcall sysv win64
linkage visibility symbolversioning soname rpath runpath
`

// Security, hacking, offensive tooling and defence.
SOURCES.SEC = `
exploit payload shellcode stub stager stage dropper loader implant beacon
backdoor rootkit bootkit keylogger spyware ransomware trojan worm virus
botnet zombie callback reverse bindshell webshell websock priv esc
escalation privesc suid sudo misconfig credential token theft looting
mimikatz lsass hashdump passthehash kerberoast asreproast golden silver
ticket dcsync bloodhound ldap kerberos ntlm saml jwt forged assertion
phishing spoofing impersonation pretexting vishing smishing baiting
tailgating piggyback dumpster lockpick bypass tamper evasion obfuscation
polymorphic metamorphic packer crypter binder stealer grabber clipper
inject hooking detouring trampoline inline detour got plt overwrite
rop jop cop ret2libc ret2csu ret2dlresolve sigreturn srop
aslr dep nx pie relro fortify canary stackguard cfh cfg
smep smap umip kgd hypervisor escape breakout vmx svm ept npt
sandbox jail seccomp landlock apparmor selinux capability drop
fuzz fuzzer fuzzing honggfuzz libfuzzer afl aflplusplus coverage
sanitizer asan msan tsan ubsan kasan kcov syzkaller
recon enumeration footprint osint whois dnsdig subdomain takeover
scanning nmap masscan banner grabbing fingerprinting enumeration
vulnerability cve cvss exploitdb metasploit msfvenom cobaltstrike
covenant sliver mythic empire powersploit covenant implant
phishkit skimmer formgrabber keycapture rat remote admin tool
persistence cronjob startup registry scheduled autorun
lateral movement pivoting tunneling socksproxy portforward chisel
exfiltration staging exfil covert channel dead drop
threat intel ioc ttp diamond model killchain mitre attack
blue team purple hunting siem soar edr xdr ndr
hardening baseline cis benchmark stig compliance audit
pentest engagement scope rules engagement report finding
forensics triage artifact timeline memorydump diskimage
incident response playbook containment eradication recovery
malware analysis sandbox detonation static dynamic unpacking
deobfuscation decompilation disassembly reversing reversing
zero day noday exploitbroker bugbounty responsible disclosure
captcha bypass antibot fingerprint spoof antidetect
proxy residential rotating datacenter mobile isp lte
opsec tradecraft burner anonymous operational
`
// Cryptography, protocols, privacy.
SOURCES.CRYPTO = `
cipher aes aes256 chacha chacha20 salsa poly1305 blowfish twofish
serpent camellia aria sm4 idea cast5 rc4 rc5 rc6
rsa dsa ecdsa eddsa ed25519 curve25519 nist p256 p384 secp256k1
dh ecdh x25519 keyexchange handshake merkle hellman
sha sha1 sha256 sha384 sha512 sha3 keccak blake blake2 blake3
md5 ripemd whirlpool tiger sm3 gost
hmac cmac gmac poly1305 siphash
kdf pbkdf pbkdf2 scrypt argon2 argon2id bcrypt crypt
salt nonce iv vector counter mode gcm ccm ctr cbc ecb ofb cfb
padding pkcs oaep mgf eme emsa pss signature verify
keypair private public keygen derive stretch wrap unwrap
vault keyring keystore hsm tpm enclave sealed attestation
tls handshake keyshare supportedgroups signaturealgorithms
certificate pki x509 crl ocsp stapling transparency ct log
anonymity onion tor hidden service relay guard exit middle
mixnet rerandomizable rerouting unlinkability deniability
commitment zeroknowledge zk snark stark bulletproof
range proof shuffle proof correctness soundness
homomorphic encryption mpc secret sharing shamir threshold
quantum resistant postquantum lattice kyber dilithium sphincs
hashchain merkletree patricia trie verkle accumulator
`
// Mathematics, logic, measurement.
SOURCES.MATH = `
vector matrix tensor scalar quaternion complex modular
prime sieve factor gcd lcm exponentiation modulus congruence
algebra geometry calculus topology combinatorics probability
variance deviation entropy random stochastic deterministic
fractal chaos strange attractor lorenz mandelbrot julia
spline bezier nurbs polygon polyline vertex edge face
geometry raytrace raster voxel tessellation fragment shader
axiom theorem lemma corollary proof contradiction induction
set theory cardinal ordinal infinite finite uncountable
boolean logic predicate quantifier implication negation
integral derivative gradient jacobian hessian divergence
curl laplacian fourier transform wavelet ztransform
laplace eigenvalue eigenvector determinant trace rank
norm metric distance hamming edit levenshtein cosine
number natural integer rational real complex quaternion
octonion modular prime composite twin fibonacci golden
sequence series limit convergence divergence asymptotic
`
// Hardware, electronics, computing machinery.
SOURCES.HARDWARE = `
circuit transistor capacitor resistor diode inductor relay mosfet igbt
fpga asic soc cpu gpu tpu npu dsp mcu arm riscv x86 x64 mips sparc
register cache ram rom sram dram ddr ddr4 ddr5 vram gddr hbm
ssd hdd nvme sata scsi raid controller firmware microcode
motherboard chipset bus pcie agp pci usb usb3 usbc thunderbolt hdmi
displayport vga dvi edp lvds panel oled amoled lcd led microled
keyboard mouse trackpad joystick gamepad controller haptic
speaker headphone amplifier dac adc codec dsp audio
battery lithium ion polymer cell charging watt volt amp ohm
capacity voltage current resistance conductance impedance
solar panel photovoltaic inverter turbine dynamo generator
motor servo stepper actuator solenoid piston hydraulic pneumatic
sensor accelerometer gyroscope magnetometer barometer lidar radar
sonar ultrasonic infrared thermal camera lens aperture shutter
clock oscillator crystal pll divider multiplier jitter phase
oscilloscope logic analyzer multimeter probe solder flux
pcb trace via pad smt throughhole stencil reflow
heatsink fan radiator thermal paste vapor chamber heatpipe
chassis rack blade enclosure psu ups pdu grounding
robotics servo arm gripper actuator sensor fusion slam
quantum computer qubit superconducting josephson iontrap
neuromorphic memristor synapse spike
antenna waveguide coax stripline microstrip filter
amplifier lna mixer oscillator synthesizer pll vco
fpga verilog vhdl synthesis place route timing
vlsi lithography nm process node wafer yield die
`
// Space, astronomy, astrophysics.
SOURCES.SPACE = `
nova supernova hypernova kilonova neutronium quarkstar
pulsar magnetar blackhole singularity eventhorizon ergosphere
quasar blazar agn Seyfert nebula cloud molecular
galaxy cosmos universe multiverse omniverse
star sun moon planet asteroid comet meteor meteorite
orbit periapsis apoapsis inclination eccentricity
gravity graviton spacetime relativity curvature geodesic
timewarp wormhole einstein rosen bridge alcubierre
photon electron proton neutron quark lepton boson fermion
hadron meson baryon neutrino antineutrino
tokamak stellarator fusion fission reactor plasma
laser maser graser gamma xray ultraviolet infrared
spectroscopy redshift blueshift doppler parallax
telescope observatory interferometer array radio
satellite shuttle rocket thruster engine stage booster
spacewalk eva module station habitat colony
terraform atmosphere magnetosphere ionosphere aurora
eclipse occultation transit conjunction opposition
constellation zodiac ecliptic celestial equinox solstice
darkmatter darkenergy hubble expansion cosmic
bigbang nucleosynthesis recombination microwave
void filament cluster supercluster laniakea
termology exoplanet habitable goldilock biosignature
terraforming domed city orbitals ringworld dyson
`
// Physics, energy, forces.
SOURCES.PHYSICS = `
momentum inertia kinetic potential elastic inelastic
collision friction drag thrust lift torque angular
pendulum harmonic oscillator resonance damping
wave amplitude frequency wavelength phase velocity
electromagnetic spectrum photon radiation decay
isotope half life chain reaction criticality
reactor containment moderator control rod
thermodynamic entropy enthalpy exergy equilibrium
carnot engine efficiency heatwork
superconductor superfluid condensate bose einstein
quantum entanglement superposition decoherence tunneling
uncertainty complementarity correspondence
particle accelerator cyclotron synchrotron collider
detector calorimeter tracker spectrometer
plasma confinement pinch instability
acoustic doppler sonar infrasound ultrasound
optical photonics fiber refraction diffraction
holography interferometry polarization
fluid dynamics turbulence vortex laminar bernoulli
magnetohydrodynamic plasma astrophysical
`
// Gaming, Minecraft, RPG, virtual worlds.
SOURCES.GAME = `
block chunk voxel biome mob creeper enderman ender zombie skeleton
witherer spider cave spider silverfish slime magma slime
nether overworld end void stronghold fortress bastion
monument woodland mansion igloo temple pyramid mineshaft
dungeon spawner trial vault loot crate gacha
redstone repeater comparator piston observer hopper
dispenser dropper anvil enchant grindstone smithing
beacon conduit shulker elytra trident totem crystal
respawn anchor lodestone compass clock map
sword blade axe pickaxe shovel hoe bow arrow crossbow
shield helmet chestplate leggings boots armor
diamond netherite iron gold leather chainmail copper
emerald ruby sapphire amethyst lapis redstone quartz
potion brewing alchemy splash lingering tipped
effect strength speed haste resistance regeneration
absorption poison wither weakness slowness levitation
warp teleport spawn rtp kit claim region plot
faction guild clan party team alliance war raid
dungeon boss raid boss elite champion
level xp skill perk talent class mastery
mage wizard sorcerer warlock necromancer druid
archer ranger hunter sniper marksman
warrior berserker gladiator paladin crusader
ninja samurai assassin rogue thief shadow
priest cleric monk paladin shaman
tank healer support damage carry
crit damage armor penetration dodge block parry
quest mission bounty contract achievement
rank tier ladder leaderboard elo rating
server network lobby minigame bedwars skyblock
survival creative hardcore anarchy prison
factions towny skyblock skywars kitpvp
practice duels arena tournament bracket
elo matchmaking queue lobby hub portal
spawnpoint bed anchor home sethome
economy coin gem shard token currency
auction house shop trade barter merchant
inventory enderchest backpack bundle slot
stack durability enchantment anvil rename
mcmmo mcmmo jobs rebirth prestige
vote crate key lootbox reward daily
streak milestone questline campaign
`
// RPG / fantasy flavour, character vibes.
SOURCES.RPG = `
knight warrior paladin crusader champion hero legend
mage wizard sorcerer warlock arcanist elementalist
cleric priest monk druid shaman oracle seer
rogue assassin ninja shadow stalker ranger hunter
bard minstrel skald storyteller
berserker marauder reaver viking spartan gladiator
samurai ronin shogun ninja sensei
pirate corsair buccaneer privateer sailor captain
necromancer lich revenant wraith specter phantom
vampire werewolf shapeshifter druidkin
dragon wyvern drake hydra chimera griffin phoenix
kraken leviathan behemoth titan colossus
golem sentinel automaton clockwork
sorcerer enchantress illusionist diviner
templar inquisitor paladin crusader
duelist fencer gladiator champion
adventurer explorer wanderer nomad drifter
vagrant hermit sage philosopher alchemist
artificer engineer tinkerer craftsman smith
beastmaster tamer breeder companion
summoner binder conjurer invoker
elementalist pyromancer cryomancer geomancer
chronomancer warper blinker teleporter
assassin bladesman shadowdancer
bard songweaver chanter hymnist
monk martial artist brawler pugilist
vanguard sentinel guardian warden keeper
reaper harvester soulkeeper deathknight
bloodmage hexer cursebrand
spellsword battlemage arcane knight
`
// Edgy handle vibes: creatures, materials, weather, terrain.
SOURCES.TUFF = `
wolf fox lynx panther tiger lion jaguar leopard cheetah
cobra viper mamba python rattler asp adder
scorpion spider wasp hornet mantis
eagle hawk falcon raven crow owl kestrel osprey
bear badger wolverine hyena jackal coyote
shark orca barracuda piranha eel ray
raven phoenix thunderbird roc
wyrm drake wyvern hydra chimera manticore
behemoth leviathan kraken titan colossus juggernaut
revenant wraith specter phantom banshee
reaper slayer butcher executioner
ronin nomad drifter wanderer vagrant hermit
sentinel guardian warden keeper hunter stalker
prowler tracker ranger scout vanguard
shadow ghost ghoul zombie revenant
obsidian onyx basalt granite marble slate
iron steel chrome titanium tungsten cobalt
silver platinum gold copper bronze brass
uranium plutonium radium neon argon krypton
quartz crystal diamond ruby sapphire emerald
amethyst topaz opal jade agate onyx
frost ice snow glacier tundra arctic
storm thunder lightning tempest hurricane
tornado cyclone vortex maelstrom
inferno blaze ember flare scorch pyre
void abyss abyssal eldritch eldritch
havoc chaos mayhem ruin decay blight
frostbite cold chill frozen glacier
nightshade hemlock belladonna wolfsbane
talon fang claw thorn spine
fury wrath rage ire vengeance
storm surge squall gale monsoon
lightning bolt spark arc plasma
dusk twilight gloom murk shadow
neon laser photon beam
reaper scythe blade edge
crimson scarlet blood crimson
obsidian void null zero
phantom ghost specter shade
wild feral savage untamed
`
// Materials, elements, colours, terrain.
SOURCES.MATERIAL = `
carbon silicon germanium selenium tellurium
lithium sodium potassium rubidium cesium
beryllium magnesium calcium strontium barium
scandium yttrium lanthanum cerium neodym
titanium zirconium hafnium vanadium niob
tantalum chromium molybdenum tungsten rhenium
manganese technetium rhenium osmium iridium
platinum palladium rhodium ruthenium
zinc cadmium mercury gallium indium thallium
tin lead bismuth polonium astatine
helium neon argon krypton xenon radon
oxygen sulfur selenium fluorine chlorine
nitrogen phosphorus arsenic antimony
hydrogen deuterium tritium
quartz feldspar mica calcite gypsum
granite basalt obsidian pumice scoria
sandstone limestone marble slate shale
concrete cement asphalt mortar plaster
crystal glass ceramic porcelain enamel
alloy brass bronze steel duralumin
kevlar graphene aerogel aerographite
carbon fiber fiberglass composite laminate
neon cyan magenta violet indigo
crimson scarlet azure teal amber
ivory ebony charcoal graphite
steel chrome silver platinum
frost ember storm shadow
`
// Motion, action, mythology, sound, misc flavour.
SOURCES.VERB = `
drift glide surge spike burst flash blink shift phase warp slide
swing dash bolt rush blaze scorch freeze shatter crush smash
strike slash pierce rend tear shred blast boom echo pulse
wave flow flux stream storm vortex spiral helix orbit spin
twist coil loop arc curve bend flex snap jump leap bound
vault dodge weave parry feint lunge charge
sprint scramble scramble scramble climb ascend descend
hover float soar dive plunge sink rise
flicker flicker stutter glitch skip lag spike
ignite kindle smolder extinguish douse
pursue chase evade escape flee retreat
ambush trap snare ensnare entangle
crack split splinter fracture rupture
gnash grind whet hone sharpen
beckon summon invoke banish dispel
channel focus cast invoke chant
merge fuse blend weld bond
forge temper quench anneal
glide swoop stoop pounce
rattle clatter clang clash
toll ring chime knell
tremor quake shudder jolt
surge swell flood deluge
gust swirl wisp wraith
creep crawl skulk slink
howl shriek wail screech
`
// Mythology and legend.
SOURCES.MYTH = `
titan olympian zeus hades poseidon ares hercules
odin thor loki freya tyr baldur
cu arthur merlin lancelot gawain
anubis ra horus osiris seth
jade emperor sunwukong monkey trickster
valkyrie valhalla asgard midgard ragnarok
fate moirai norn destiny prophecy oracle
sibyl augur omen portent sign
arcane mystic occult esoteric hermetic
alchemy elixir philosopher transmute
relic artifact talisman amulet sigil
rune glyph sigil ward enchant
grimoire tome codex scroll
spirit soul wraith revenant
djinn genie efreet ifrit
kitsune tanuki tengu oni yokai
golem homunculus simulacrum
chimera gorgon sphinx minotaur
cerberus hydra manticore basilisk
pegasus griffin hippogriff
leviathan behemoth ziz
fountain yggdrasil worldtree
`
// Misc techy flavour: abbreviations, units, odds and ends.
SOURCES.MISC = `
zero null void nil none empty blank
alpha beta gamma delta epsilon zeta eta theta
kilo mega giga tera peta exa zetta
byte kilobyte megabyte gigabyte terabyte
bit nibble word dword qword
mips flops hertz kilohertz megahertz
gigahertz teraflop petaflop
amp volt watt ohm farad henry tesla weber
joule calorie newton pascal bar
meter kilometer micron nanometer picometer
second millisecond microsecond nanosecond
minute hour day week month year
kelvin celsius fahrenheit rankine
mole candela lumen lux
radian degree steradian
ascii unicode utf8 utf16 utf32 latin1
base64 base32 base16 hexa octal binary
crc checksum hash digest fingerprint
uuid guid ulid snowflake
version major minor patch semver
cache hit miss stale evict
queue stack heap graph tree
matrix vector tensor array
kernel daemon agent worker
cluster shard replica node
region zone cell pod
lint format prettier eslint
bundle tree shake minify uglify
lint type strict sloppy
docs readme changelog license
`
// Top-up vocabulary: sound, time, nature, culture, extra tech.
SOURCES.EXTRA = `
thunder lightning gale squall tempest cyclone
hurricane typhoon monsoon blizzard avalanche tsunami
magma lava ash plume crater caldera
glacier iceberg frost snowfall hail sleet
rainfall drizzle mist fog haze smog
breeze gust gale windstorm
sunlight sunrise sunset dusk dawn twilight
midnight nightfall starlight moonlight
solstice equinox eclipse aurora
chrono clock timer stopwatch hourglass sundial
clockwork escapement pendulum quartz
epoch era age eon millennium century decade
moment instant jiffy tick tock
season spring summer autumn winter
tide ebb flow current undertow
river stream creek brook cascade waterfall
ocean sea abyss trench reef atoll
mountain peak ridge summit cliff canyon
valley gorge basin plain plateau
desert dune oasis savanna tundra
forest jungle canopy grove thicket
swamp marsh bog fen mire
vulcan volcanic seismic tremor quake
tempest stormstorm rainfall
orchestra symphony cadence tempo rhythm
melody harmony chord note scale
bass treble alto soprano tenor
reverb echo delay chorus flanger
waveform oscillator filter envelope
synth sampler sequencer arpeggiator
drum bassline hihat snare kick
vinyl analog digital hybrid
pixel sprite tileset parallax
shader glsl hlsl vulkan opengl
directx metal mantle cuda opencl
driver kernelmod userspace
container image layer union overlay
registry manifest digest tag
orchestration scheduler binpack autoscale
serverless lambda function edge
pipeline workflow dag task
observability metric trace span log
alerting paging oncall incident
runbook postmortem rootcause
sre slo sli errorbudget
oncall rotation escalation
snapshot checkpoint restore backup
replication failover durability
consistency eventual strong quorum
partition tolerance availability
throughput latency tail p99 p999
capacity provisioning elasticity
migration cutover dualwrite backfill
testing load stress soak chaos
bluegreen canary shadow traffic
rollback forward fixup hotfix
patch release rollout deploy
versioning branching trunk feature
review pair mob trunk
docs runbook tutorial reference
team squad guild chapter tribe
velocity sprint kanban scrum
backlog epic story point
retro demo standup planning
`

// Final top-up: extra tech roots and cool-sounding syllables.
SOURCES.EXTRA2 = `
hypersync quantumloop zeroedge darkfiber
nightsky coldfire doomforge ragequit
lagcomp desync rollbacknet prediction
netcode hitreg tickrate interpolation
anticheat watchdog sentinel guard
speedrun glitchless anypercent
frameperfect inputbuffer
combo juggle punish whiff
dashdance wavedash lcancel techskill
tryhard sweatlord clutch ace
tilted salty malding cope seethe
poggers hype squad flex
lfg lfm raidcarry boost
xp grind farm loot spawn
crit oneshot burstglass cannon
bruiser tanky squishy glasscannon
aggro kite peel engage disengage
gank rotate roam invade counter
camp trap cheese rat
strat lineup execute default
igl entry fragger support flexer
clutchround ecoforce fullbuy
ace pentakill quadra triple
collateral noscope quickscope
wallbang flicktrack sprays transfer
crosshair sens dpi edpi
refresh overclock undervolt delid
benchmark stresstest burnin
latency ping lag spike rubberband
lagfest pingpong rollback
bytebeat chipnoise synthwave
retrowave outrun vaporwave
steampunk cybergoth industrial
mech exosuit powerarmor
drone swarm hive cluster
nanotech graphene metamaterial
fusioncell arcreactor plasmaforge
zeropoint vacuum flux
singularity kernelmind
starforge voidwalker
nightreaper doombringer
stormcaller thunderlord
shadowstrike voidblade
frostfang emberclaw
ironwill steelspine
hexweaver runeblade
soulfire deathbrand
wolfpack ravenhorde
`
module.exports = (() => {
  const seen = new Set()
  const words = []
  for (const text of Object.values(SOURCES)) {
    for (const raw of text.split(/\s+/)) {
      const word = raw.toLowerCase()
      if (!/^[a-z0-9]{2,13}$/.test(word) || seen.has(word)) continue
      seen.add(word)
      words.push(word)
    }
  }
  return { WORDS: words, SOURCES }
})()

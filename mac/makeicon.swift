import AppKit

// Dak's icon: a petrol pillar box with a gold letter going into its slot.
// Drawn on the macOS icon grid: an 824pt rounded body on a 1024 canvas.
let S: CGFloat = 1024
let c = { (r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat) in NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a) }
// Petrol, Dak's accent (#1f6f8b). The names say what each shade is for, not its hue.
let red = c(31, 111, 139, 1), redHi = c(72, 160, 188, 1), redLo = c(17, 70, 90, 1), redDark = c(9, 44, 58, 1)
let gold = c(242, 183, 5, 1), paper = c(250, 248, 244, 1)

let img = NSImage(size: NSSize(width: S, height: S))
img.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)

// Tile with a soft drop shadow, then a light warm-grey gradient so the petrol carries.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 30, color: NSColor.black.withAlphaComponent(0.28).cgColor)
c(232, 230, 226, 1).setFill(); tilePath.fill()
ctx.restoreGState()
ctx.saveGState(); tilePath.addClip()
NSGradient(starting: c(222, 219, 213, 1), ending: c(246, 245, 242, 1))!.draw(in: tile, angle: 90)

let cx = S / 2, w: CGFloat = 330, x0 = cx - w / 2
let baseY: CGFloat = 214, bodyH: CGFloat = 400

// Ground shadow.
c(40, 50, 60, 0.22).setFill()
NSBezierPath(ovalIn: NSRect(x: cx - 230, y: baseY - 40, width: 460, height: 60)).fill()

// Plinth: two dark tiers.
func cylinder(_ r: NSRect, _ cols: [NSColor], radius: CGFloat = 10) {
    let p = NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius)
    NSGradient(colors: cols, atLocations: [0, 0.3, 0.55, 1], colorSpace: .sRGB)!.draw(in: p, angle: 0)
}
let darkCols = [redDark, c(24, 92, 116, 1), redLo, redDark]
cylinder(NSRect(x: x0 - 34, y: baseY - 22, width: w + 68, height: 40), darkCols, radius: 12)
cylinder(NSRect(x: x0 - 16, y: baseY + 12, width: w + 32, height: 30), darkCols, radius: 8)

// Body: a cylinder, lit from the left.
let bodyCols = [redLo, redHi, red, redLo]
cylinder(NSRect(x: x0, y: baseY + 36, width: w, height: bodyH), bodyCols, radius: 6)

// Door outline and keyhole.
let door = NSRect(x: x0 + 76, y: baseY + 70, width: w - 152, height: 168)
let doorPath = NSBezierPath(roundedRect: door, xRadius: 16, yRadius: 16)
doorPath.lineWidth = 6; redDark.withAlphaComponent(0.55).setStroke(); doorPath.stroke()
let doorHi = NSBezierPath(roundedRect: door.offsetBy(dx: -2, dy: 2), xRadius: 16, yRadius: 16)
doorHi.lineWidth = 2; redHi.withAlphaComponent(0.5).setStroke(); doorHi.stroke()
redDark.setFill(); NSBezierPath(ovalIn: NSRect(x: cx - 8, y: door.minY + 34, width: 16, height: 16)).fill()

// Collection plate: cream, lines suggesting times.
let plate = NSRect(x: cx - 62, y: door.maxY - 82, width: 124, height: 62)
paper.setFill(); NSBezierPath(roundedRect: plate, xRadius: 6, yRadius: 6).fill()
c(150, 150, 150, 1).setFill()
for i in 0..<3 { NSBezierPath(roundedRect: NSRect(x: plate.minX + 16, y: plate.minY + 14 + CGFloat(i) * 14, width: i == 1 ? 70 : 92, height: 6), xRadius: 3, yRadius: 3).fill() }

// Slot hood: a ledge, the dark mouth, and a letter halfway in.
let slotY = baseY + 36 + bodyH - 178
cylinder(NSRect(x: x0 + 34, y: slotY + 30, width: w - 68, height: 26), [redLo, c(60, 146, 174, 1), red, redLo], radius: 6)
c(6, 24, 32, 1).setFill()
NSBezierPath(roundedRect: NSRect(x: x0 + 52, y: slotY + 8, width: w - 104, height: 24), xRadius: 8, yRadius: 8).fill()
ctx.saveGState()
ctx.translateBy(x: cx + 6, y: slotY + 16)
ctx.rotate(by: -0.07)
let letter = NSRect(x: -96, y: 0, width: 192, height: 108)
ctx.setShadow(offset: CGSize(width: 0, height: -4), blur: 10, color: NSColor.black.withAlphaComponent(0.25).cgColor)
paper.setFill(); NSBezierPath(roundedRect: letter, xRadius: 10, yRadius: 10).fill()
ctx.setShadow(offset: .zero, blur: 0, color: nil)
let flap = NSBezierPath(); flap.move(to: NSPoint(x: letter.minX + 10, y: letter.maxY - 10)); flap.line(to: NSPoint(x: 0, y: letter.midY - 4)); flap.line(to: NSPoint(x: letter.maxX - 10, y: letter.maxY - 10))
flap.lineWidth = 7; flap.lineJoinStyle = .round; flap.lineCapStyle = .round; c(200, 196, 190, 1).setStroke(); flap.stroke()
gold.setFill(); NSBezierPath(roundedRect: NSRect(x: letter.maxX - 52, y: letter.maxY - 50, width: 34, height: 38), xRadius: 3, yRadius: 3).fill()
ctx.restoreGState()
// The mouth's lower lip is drawn over the letter, so the letter reads as going in.
c(6, 24, 32, 1).setFill()
NSBezierPath(roundedRect: NSRect(x: x0 + 52, y: slotY + 8, width: w - 104, height: 16), xRadius: 6, yRadius: 6).fill()
cylinder(NSRect(x: x0 + 40, y: slotY - 2, width: w - 80, height: 12), bodyCols, radius: 4)

// Cap: a band, then the dome with a small knob.
let capY = baseY + 36 + bodyH
cylinder(NSRect(x: x0 - 14, y: capY - 6, width: w + 28, height: 34), darkCols, radius: 8)
let dome = NSBezierPath()
dome.move(to: NSPoint(x: x0 - 4, y: capY + 26))
dome.curve(to: NSPoint(x: x0 + w + 4, y: capY + 26), controlPoint1: NSPoint(x: x0 + 8, y: capY + 196), controlPoint2: NSPoint(x: x0 + w - 8, y: capY + 196))
dome.close()
NSGradient(colors: [redLo, redHi, red, redLo], atLocations: [0, 0.32, 0.6, 1], colorSpace: .sRGB)!.draw(in: dome, angle: 0)
cylinder(NSRect(x: cx - 22, y: capY + 146, width: 44, height: 30), darkCols, radius: 14)

ctx.restoreGState()
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))

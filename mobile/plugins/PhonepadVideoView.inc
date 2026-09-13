#if !TARGET_OS_OSX
// Keep the upstream decoder and renderer. Only configure the public Metal view.
// No private KVC, method swizzling, CPU pixel conversion or JS frame callbacks.
@interface PhonepadVideoView : RTCMTLVideoView
@property(nonatomic) CGSize phonepadSourceSize;
@end

@implementation PhonepadVideoView
- (void)setSize:(CGSize)size {
    [super setSize:size];
    __weak PhonepadVideoView *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
        weakSelf.phonepadSourceSize = size;
        [weakSelf setNeedsLayout];
    });
}

- (void)didMoveToWindow {
    [super didMoveToWindow];
    [self setNeedsLayout];
}

- (void)layoutSubviews {
    [super layoutSubviews];
    UIScreen *screen = self.window.windowScene.screen;
    for (UIView *child in self.subviews) {
        if (![child isKindOfClass:NSClassFromString(@"MTKView")]) continue;
        MTKView *metal = (MTKView *)child;
        // A preference, not a promise: iOS still governs power/thermal limits.
        metal.preferredFramesPerSecond = screen ? screen.maximumFramesPerSecond : 60;
        CGSize drawable = metal.drawableSize;
        CGSize source = self.phonepadSourceSize;
        if (drawable.width <= 0 || drawable.height <= 0 || source.width <= 0 || source.height <= 0) continue;
        // Upstream may multiply source pixels by Retina scale again. Preserve
        // its rotation/aspect, but never allocate more pixels than the source.
        CGFloat ratio = sqrt((source.width * source.height) / (drawable.width * drawable.height));
        if (ratio < 1) {
            metal.drawableSize = CGSizeMake(MAX(1, floor(drawable.width * ratio)),
                                           MAX(1, floor(drawable.height * ratio)));
        }
    }
}
@end
#endif

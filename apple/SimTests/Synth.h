// Touches that XCUICoordinate cannot make, such as two fingers moving together.
// They go through XCTest's own event synthesis, which is not public API. The class and
// method names below have been the same since Xcode 10. If they go away, the tests that
// need them fail with a clear message instead of passing.
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Each path is a list of points in screen coordinates for the given orientation. All
/// fingers go down together, move through their points over `duration` seconds and lift.
BOOL SynthTouches(NSArray<NSArray<NSValue *> *> *paths, NSTimeInterval duration, long long orientation,
                  NSError **error);

/// The selectors of XCTest's event classes, to look for any stylus or pencil input.
NSString *SynthSelectors(void);

NS_ASSUME_NONNULL_END

